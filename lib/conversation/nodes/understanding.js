/**
 * Reading the text: classify it, plan the tool calls, and answer the cases
 * that do not need an intent — chat, "I am at …", and the stops on a route.
 */
const { Node } = require('../../graph');
const memory = require('../../memory');
const tools = require('../../tools');
const opensearch = require('../../opensearch');
const talk = require('../../talk');
const { classify, atStatement, stopsQuery } = require('../../api');
const h = require('../handlers');

class UnderstandNode extends Node {
  constructor() { super('understand', { description: 'Classify the text with the chat memory and plan the tool calls' }); }

  async run(state) {
    const { hash, user: s, text } = state;
    if (text) h.noteRephrase(hash, s, text);
    const prior = memory.recent(hash).filter((m, i, arr) =>
      !(i === arr.length - 1 && m.direction === 'in' && m.body === String(text || '').trim()));
    const c0 = await classify(text || '', { memory: prior, facts: h.databaseFacts(hash, s) });
    const c = text ? h.asFuelAreaFollowUp(hash, text, c0) : c0;
    const patch = { prior, classified: c };
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

/* Ordinary conversation. Reached from the understand router, and from the
   intent router when the classifier said chat. The model writes the reply;
   the guard node checks it for figures on the way out. */
class ChatNode extends Node {
  constructor() { super('chat', { description: 'Talk — no lookup, no figures' }); }

  async run(state) {
    const c = state.classified || {};
    state.reply(await talk.reply(state.from, state.text, state.prior, c.intent === 'chat' ? c.arg : ''));
    state.source = 'chat';
  }
}

class AtPlaceNode extends Node {
  constructor() { super('at_place', { description: '"I am at …" — open that station, or the legs through that stop' }); }

  async run(state) {
    state.reply(await h.answerAt(state.from, state.hash, state.user, atStatement(state.text)));
  }
}

class StopsNode extends Node {
  constructor() { super('stops', { description: 'The stops along a recorded leg' }); }

  async run(state) {
    state.reply(await h.answerStops(state.from, stopsQuery(state.text)));
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

module.exports = { UnderstandNode, ChatNode, AtPlaceNode, StopsNode, FollowUpNode };
