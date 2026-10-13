/**
 * Reading the text. The router node picks the agent: chat, or data. The data
 * agent classifies the line, plans its tool calls, reads fragments against
 * what was just shown, and answers "I am at …" and the stops on a route; a
 * line it cannot place gets a clarifying question, or goes back to chat.
 */
const { Node } = require('../../graph');
const memory = require('../../memory');
const tools = require('../../tools');
const opensearch = require('../../opensearch');
const chat = require('../../agents/chat');
const router = require('../../agents/router');
const context = require('../../agents/context');
const topics = require('../../agents/topic');
const { classify, atStatement } = require('../../api');
const h = require('../handlers');

/** Chat history before this message — the inbound line itself is already logged. */
function priorOf(hash, text) {
  return memory.recent(hash).filter((m, i, arr) =>
    !(i === arr.length - 1 && m.direction === 'in' && m.body === String(text || '').trim()));
}

/** An open step is waiting: a fare question, or a report waiting for its amount. */
function busy(state) {
  return !!(memory.thread(state.hash) || state.user.pending);
}

class RouteNode extends Node {
  constructor() { super('route_line', { description: 'Chat agent or data agent? Decided on the words, before any lookup' }); }

  run(state) {
    const topic = topics.get(state.user);
    return {
      prior: priorOf(state.hash, state.text),
      topic,
      dispatch: router.decide(state.text, { topic, busy: busy(state) })
    };
  }
}

class UnderstandNode extends Node {
  constructor() { super('understand', { description: 'Classify the text with the chat memory and plan the tool calls' }); }

  async run(state) {
    const { hash, user: s, text } = state;
    if (text) h.noteRephrase(hash, s, text);
    const prior = priorOf(hash, text);
    const c0 = await classify(text || '', { memory: prior, facts: h.databaseFacts(hash, s) });
    const c = text ? h.asFuelAreaFollowUp(hash, text, c0) : c0;
    const patch = { prior, classified: c, topic: topics.get(s) };
    if (text) {
      const planned = tools.plan(text, c);
      c.toolCalls = planned.calls.map(call => call.name);
      const searched = planned.calls.find(call => call.name === 'opensearch');
      if (searched) searched.result = await opensearch.search(searched.arguments.query, searched.arguments.kind);
      patch.planned = planned;
      patch.parse = c;
    }
    return patch;
  }
}

/* The chat agent. Reached from the router when the line is small talk or a
   feeling, and from the data agent when it declines a line. It sees no
   tables and no figures; the guard node checks its reply on the way out. */
class ChatNode extends Node {
  constructor() { super('chat', { description: 'Chat agent — talk, no lookup, no figures' }); }

  async run(state) {
    const c = state.classified || {};
    const offer = (state.dispatch && state.dispatch.offer) || (c.intent === 'chat' ? c.arg : '');
    state.reply(await chat.reply({ to: state.from, text: state.text, prior: state.prior, offer, topic: state.topic }));
    if (!state.classified) state.parse = { intent: 'chat', places: [], via: 'router' };
    state.source = 'chat';
  }
}

/* "circle?", "e be how much", "line dey?" right after a board or a route —
   the fragment is read against what was just shown. */
class InContextNode extends Node {
  constructor() { super('in_context', { description: 'A fragment read against the board or route just shown' }); }

  async run(state) {
    const { from, hash } = state;
    const r = context.read(state.text, state.topic, state.classified);
    if (!r) return;
    if (r.action === 'fare') {
      state.parse = { ...state.classified, intent: 'fare', places: [r.from, r.to], via: 'context' };
      return void state.reply(await h.answerFare(from, hash, r.from, r.to));
    }
    if (r.action === 'board') {
      state.parse = { ...state.classified, intent: 'station', places: [r.station], via: 'context' };
      return void state.reply(h.withNote(h.answerStationBoard(from, hash, r.station), 'To where? Tap the place and I will show you the fare.'));
    }
    if (r.action === 'queue') {
      const places = [r.from, r.to].filter(Boolean);
      state.parse = { ...state.classified, intent: 'queue', places, via: 'context' };
      return void state.reply(await h.answerQueue(from, hash, { places }));
    }
  }
}

class ClarifyNode extends Node {
  constructor() { super('clarify', { description: 'A question the data agent could not place — ask back with the likely meanings' }); }

  run(state) {
    state.reply(h.clarify(state.from, state.hash, state.user, state.text));
  }
}

class AtPlaceNode extends Node {
  constructor() { super('at_place', { description: '"I am at …" — open that station, or the legs through that stop' }); }

  async run(state) {
    state.reply(await h.answerAt(state.from, state.hash, state.user, atStatement(state.text)));
  }
}

class StopsNode extends Node {
  constructor() { super('stops', { description: 'The stops along a leg — named, or the one just shown' }); }

  async run(state) {
    state.parse = { ...(state.parse || {}), intent: 'stops' };
    state.reply(await h.answerStopsAsk(state.from, state.hash, state.user, state.text));
  }
}

const INQUIRIES = new Set([
  'fuel', 'road', 'road_history', 'queue', 'chart', 'cheapest', 'help', 'where', 'incident_history',
  'addon_add', 'addon_remove', 'addon_list', 'greet', 'menu'
]);

/* A fresh inquiry closes the open fare question. A follow-up ("address",
   "how much is the petrol") is answered from the row the last reply showed. */
class FollowUpNode extends Node {
  constructor() { super('follow_up', { description: 'Close a stale fare question, or answer about the row just shown' }); }

  async run(state) {
    const { from, hash, user: s, text } = state;
    const c = state.classified;
    const guessed = c.nlu === 'heuristic' && (c.intent === 'menu' || c.intent === 'greet');
    state.inquiry = !guessed && INQUIRIES.has(c.intent);
    if (!text) return;
    if (state.inquiry) memory.setThread(hash, null);
    const asked = await h.answerFromAsk(from, hash, s, text, c);
    if (asked && !(c.fuelId && c.ask === 'price')) return void state.reply(asked);
    const about = await h.answerAboutSubject(from, hash, s, text);
    if (about) state.reply(about);
  }
}

module.exports = {
  RouteNode, UnderstandNode, ChatNode, InContextNode, ClarifyNode, AtPlaceNode, StopsNode, FollowUpNode, busy
};
