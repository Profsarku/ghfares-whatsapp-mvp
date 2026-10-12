/**
 * The conversation engine. Every inbound message — API, WhatsApp, or
 * Messenger — becomes a ConversationState and runs once through the
 * conversation graph (lib/conversation/graph.js). The graph decides what to
 * answer; the domain handlers (lib/conversation/handlers.js) build it.
 */
const graph = require('./conversation/graph');
const { ConversationState } = require('./conversation/state');
const h = require('./conversation/handlers');

let last = null;

/**
 * Run one message through the graph.
 * @returns {Promise<ConversationState>} replies, parse, and the trace of visited nodes
 */
async function run(input) {
  const state = new ConversationState(input);
  last = state;
  await state.scoped(() => graph.invoke(state));
  return state;
}

/** Reply payloads for one message. */
async function handle(input) {
  return (await run(input)).replies;
}

module.exports = {
  handle, run, graph,
  welcome: h.welcome, startMenu: h.startMenu, keywordCard: h.keywordCard, mainMenu: h.mainMenu,
  addonMenu: h.addonMenu, reactionId: h.reactionId, COMMANDS: h.COMMANDS, ICE_BREAKERS: h.ICE_BREAKERS,
  ICE_MAP: h.ICE_MAP, conversationalAutomationConfig: h.conversationalAutomationConfig, expandCommand: h.expandCommand,
  pushFuelAlert: h.pushFuelAlert, pushRoadAlert: h.pushRoadAlert, pushQueueAlert: h.pushQueueAlert,
  pushChartRevision: h.pushChartRevision,
  /** The parse of the most recent message. Single-threaded callers only — ask() uses run(). */
  get lastParse() { return last ? last.parse : { intent: null, places: [], via: 'api' }; },
  get lastTrace() { return last ? last.trace.map(step => step.node) : []; }
};
