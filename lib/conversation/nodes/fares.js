/**
 * Fare steps that come before the intent router: an amount for a pending
 * report, a quick report on a saved route, the next answer in an open fare
 * question, and a route named in the text.
 */
const { Node } = require('../../graph');
const wa = require('../../wa');
const caps = require('../../capabilities');
const memory = require('../../memory');
const crowd = require('../../crowd');
const { api, routeMention, isVaguePlace } = require('../../api');
const h = require('../handlers');

class FareAmountNode extends Node {
  constructor() { super('fare_amount', { description: 'The amount for a pending fare report' }); }

  async run(state) {
    const s = state.user;
    const r = await api.reportFare(s.pending.from, s.pending.to, state.classified.amount, state.hash);
    s.pending = null;
    if (!r) return void state.reply(wa.text(state.from, 'Could not log that one.'));
    state.reply(await h.fareReportReplies(state.from, r));
  }
}

/* The quick-report add-on: a bare number with a saved route is a full report. */
class QuickReportNode extends Node {
  constructor() { super('quick_report', { description: 'REPORT add-on — a bare number is a report on the saved route' }); }

  async run(state) {
    const s = state.user;
    const r = await api.reportFare(s.route.from, s.route.to, state.classified.amount, state.hash);
    if (r) state.reply(await h.fareReportReplies(state.from, r));
  }
}

class OpenRouteNode extends Node {
  constructor() { super('open_route', { description: 'The next answer in an open fare question' }); }

  async run(state) {
    const continued = await h.continueOpenRoute(state.from, state.hash, state.text);
    if (continued) state.reply(continued);
  }
}

class FareMentionNode extends Node {
  constructor() { super('fare_mention', { description: 'A route named in the text — the fare, or ask for the missing end' }); }

  async run(state) {
    const { from, hash } = state;
    const mentioned = routeMention(state.text);
    if (mentioned && mentioned.fromId && mentioned.toId) {
      return void state.reply(await h.answerFare(from, hash, mentioned.fromId, mentioned.toId));
    }
    if (!mentioned) return;
    const open = { intent: 'fare', fromText: mentioned.fromText, toText: mentioned.toText, fromId: mentioned.fromId, toId: mentioned.toId };
    const unknownSide = !mentioned.fromId ? mentioned.fromText : mentioned.toText;
    if (unknownSide && !isVaguePlace(unknownSide)) {
      open.naming = unknownSide;
      open.picking = mentioned.fromId ? 'to' : 'from';
      crowd.signal(hash, 'unknown', unknownSide);
    }
    memory.setThread(hash, open);
    state.parse = { intent: 'fare', places: [open.fromId, open.toId].filter(Boolean), via: 'memory' };
    state.reply(await h.askRouteFollowUp(from, open));
  }
}

/* Routing predicates for the fare steps, used by the graph's edges. */
const when = {
  fareAmount: state => !!(state.user.pending && state.classified.amount != null),
  quickReport: state => state.classified.amount != null && /^[\d.\s₵]+$/.test(String(state.text || ''))
    && caps.granted(state.hash, 'report.fast') && !!state.user.route,
  openRoute: state => !!(state.text && !state.inquiry),
  fareMention: state => !!(state.text && !state.inquiry
    && (state.classified.intent === 'fare' || h.fareAsk(state.text)))
};

module.exports = { FareAmountNode, QuickReportNode, OpenRouteNode, FareMentionNode, when };
