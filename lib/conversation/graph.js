/**
 * The conversation graph — every inbound message runs through it once.
 *
 *   load → entry ─┬─ forget / welcome_request / country_tap ─────────────┐
 *                 └─ prepare_text → triage ─┬─ onboarding, country_unavailable,
 *                                           │  road_photo, location ──────┤
 *                                           ├─ tap_* ─(no match)─┐       │
 *                                           └─ resume ◄──────────┘       │
 *   resume ─┬─ road_report_step / fuel_place / typed_place ─(declined)─┐ │
 *           └─ understand ◄────────────────────────────────────────────┘ │
 *   understand ─┬─ chat / at_place / stops ──────────────────────────────┤
 *               └─ follow_up → fare steps → intent → <intent node> ──────┤
 *                                                                        ▼
 *                                              guard → decorate → remember → END
 *
 * Nodes do the work (lib/conversation/nodes). Edges, all in this file, do
 * the routing. A node that replies sets state.done; a node that declines
 * leaves it unset and the edge moves on to the next candidate.
 * GET /v1/graph prints the structure as Mermaid.
 */
const { StateGraph, FunctionNode, START, END } = require('../graph');
const memory = require('../memory');
const talk = require('../talk');
const { atStatement, stopsQuery } = require('../api');
const h = require('./handlers');
const { SubscriberCheckpointer } = require('./checkpointer');
const { LoadNode, ForgetNode, GuardNode, DecorateNode, RememberNode } = require('./nodes/lifecycle');
const entry = require('./nodes/entry');
const { TAPS } = require('./nodes/taps');
const pending = require('./nodes/pending');
const understanding = require('./nodes/understanding');
const fares = require('./nodes/fares');
const { INTENT_NODES, FallbackIntent } = require('./nodes/intents');

const FINISH = 'guard';
const TAP_BY_PREFIX = new Map(TAPS.map(tap => [tap.prefix, tap.name]));
const INTENT_BY_NAME = new Map();
for (const node of INTENT_NODES) for (const intent of node.intents) INTENT_BY_NAME.set(intent, node.name);
INTENT_BY_NAME.set('chat', 'chat');

/** After a node that may decline: finish if it replied, else go on. */
const doneOr = next => state => (state.done ? FINISH : (typeof next === 'function' ? next(state) : next));

/* ── routers ── each reads the state and names the next node */

function entryRoute(state) {
  if (state.deleting) return 'forget';
  if (state.type === 'request_welcome') return 'welcome_request';
  if (state.tap && String(state.tap).startsWith('country:')) return 'country_tap';
  return 'prepare_text';
}

function triage(state) {
  const s = state.user;
  if (!s.country || h.awaitingCountry(s)) return 'onboarding';
  if (!h.liveCountry(s)) return 'country_unavailable';
  if (state.image || state.type === 'image') return 'road_photo';
  if (state.location) return 'location';
  if (state.tap && TAP_BY_PREFIX.has(state.tapParts[0])) return TAP_BY_PREFIX.get(state.tapParts[0]);
  return 'resume';
}

function resume(state) {
  const s = state.user;
  if (!state.text) return 'understand';
  if (h.awaitingRoadWhere(s)) return 'road_report_step';
  if (s.context && s.context.awaitingFuelPlace) return 'fuel_place';
  if (h.awaitingPlace(s)) return 'typed_place';
  return 'understand';
}

function afterFuelPlace(state) {
  return state.text && h.awaitingPlace(state.user) ? 'typed_place' : 'understand';
}

function afterUnderstand(state) {
  const { text } = state;
  if (!text) return 'follow_up';
  const busy = memory.thread(state.hash) || state.user.pending;
  if (talk.shouldChat(text, state.classified, state.planned) && (!busy || talk.breaksThread(state.classified))) return 'chat';
  if (atStatement(text)) return 'at_place';
  if (stopsQuery(text)) return 'stops';
  return 'follow_up';
}

/* The fare steps are tried in order; each later one is reached when the
   earlier ones do not apply or decline. */
const FARE_STEPS = [
  ['fare_amount', fares.when.fareAmount],
  ['quick_report', fares.when.quickReport],
  ['open_route', fares.when.openRoute],
  ['fare_mention', fares.when.fareMention]
];

function fareStepFrom(index) {
  return state => {
    for (let i = index; i < FARE_STEPS.length; i++) {
      const [name, applies] = FARE_STEPS[i];
      if (applies(state)) return name;
    }
    return 'intent';
  };
}

function intentRoute(state) {
  return INTENT_BY_NAME.get(state.classified && state.classified.intent) || 'fallback';
}

/* ── the graph ── */

function build() {
  const graph = new StateGraph();

  graph.addNode(new LoadNode());
  graph.addNode(new ForgetNode());
  for (const Node of [entry.WelcomeRequestNode, entry.CountryTapNode, entry.PrepareTextNode, entry.OnboardingNode,
    entry.CountryUnavailableNode, entry.RoadPhotoNode, entry.LocationNode]) graph.addNode(new Node());
  graph.addNode(new FunctionNode('triage', () => {}, { description: 'Route on country, photo, pin, or tap' }));
  for (const tap of TAPS) graph.addNode(tap);
  graph.addNode(new FunctionNode('resume', () => {}, { description: 'Is the text the answer to an open question?' }));
  for (const Node of [pending.RoadReportStepNode, pending.FuelPlaceNode, pending.TypedPlaceNode]) graph.addNode(new Node());
  for (const Node of [understanding.UnderstandNode, understanding.ChatNode, understanding.AtPlaceNode,
    understanding.StopsNode, understanding.FollowUpNode]) graph.addNode(new Node());
  for (const Node of [fares.FareAmountNode, fares.QuickReportNode, fares.OpenRouteNode, fares.FareMentionNode]) graph.addNode(new Node());
  graph.addNode(new FunctionNode('intent', () => {}, { description: 'Route on the classified intent' }));
  for (const node of INTENT_NODES) graph.addNode(node);
  graph.addNode(new FallbackIntent());
  graph.addNode(new GuardNode());
  graph.addNode(new DecorateNode());
  graph.addNode(new RememberNode());

  const tapNames = TAPS.map(tap => tap.name);
  const intentNames = [...new Set(INTENT_BY_NAME.values()), 'fallback'];
  const fareTargets = [...FARE_STEPS.map(([name]) => name), 'intent'];

  graph.addEdge(START, 'load');
  graph.addConditionalEdges('load', entryRoute, ['forget', 'welcome_request', 'country_tap', 'prepare_text']);
  graph.addEdge('forget', FINISH);
  graph.addEdge('welcome_request', FINISH);
  graph.addEdge('country_tap', FINISH);
  graph.addConditionalEdges('prepare_text', doneOr('triage'), [FINISH, 'triage']);

  graph.addConditionalEdges('triage', triage,
    ['onboarding', 'country_unavailable', 'road_photo', 'location', ...tapNames, 'resume']);
  for (const name of ['onboarding', 'country_unavailable', 'road_photo', 'location']) graph.addEdge(name, FINISH);
  for (const name of tapNames) graph.addConditionalEdges(name, doneOr('resume'), [FINISH, 'resume']);

  graph.addConditionalEdges('resume', resume, ['road_report_step', 'fuel_place', 'typed_place', 'understand']);
  graph.addEdge('road_report_step', FINISH);
  graph.addConditionalEdges('fuel_place', doneOr(afterFuelPlace), [FINISH, 'typed_place', 'understand']);
  graph.addConditionalEdges('typed_place', doneOr('understand'), [FINISH, 'understand']);

  graph.addConditionalEdges('understand', afterUnderstand, ['chat', 'at_place', 'stops', 'follow_up']);
  for (const name of ['chat', 'at_place', 'stops']) graph.addEdge(name, FINISH);

  graph.addConditionalEdges('follow_up', doneOr(fareStepFrom(0)), [FINISH, ...fareTargets]);
  graph.addEdge('fare_amount', FINISH);
  graph.addConditionalEdges('quick_report', doneOr(fareStepFrom(2)), [FINISH, ...fareTargets.slice(2)]);
  graph.addConditionalEdges('open_route', doneOr(fareStepFrom(3)), [FINISH, ...fareTargets.slice(3)]);
  graph.addConditionalEdges('fare_mention', doneOr('intent'), [FINISH, 'intent']);

  graph.addConditionalEdges('intent', intentRoute, intentNames);
  for (const name of intentNames) if (name !== 'chat') graph.addEdge(name, FINISH);

  graph.addEdge('guard', 'decorate');
  graph.addEdge('decorate', 'remember');
  graph.addEdge('remember', END);

  return graph.compile({ checkpointer: new SubscriberCheckpointer() });
}

module.exports = build();
