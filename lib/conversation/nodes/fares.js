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
const { api, routeMention, destinationOnly, isVaguePlace } = require('../../api');
const topics = require('../../agents/topic');
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
    const c = state.classified || {};
    const mentioned = routeMention(state.text);
    const both = mentioned && mentioned.fromId && mentioned.toId;

    /* "i paid 8 from circle to kaneshie", or the route after "which route was that?" */
    const waiting = memory.thread(hash);
    const amount = c.fareReport ? c.amount : (waiting && waiting.intent === 'report' ? waiting.amount : null);
    if (amount != null && (c.fareReport || both)) {
      const topic = topics.get(state.user);
      /* No route said, but one is on screen: ask before logging against it. */
      if (!both && topic && topic.kind === 'route') {
        state.parse = { ...c, intent: 'fare', places: [topic.fromId, topic.toId], via: 'report' };
        return void state.reply(wa.buttons(from,
          `Thanks for telling me 🙏 Was that *₵${amount}* for *${topic.fromName} → ${topic.toName}*?`,
          [
            { id: `paid:${topic.fromId}:${topic.toId}:${amount}`, title: 'Yes, log it' },
            { id: `reportroute:${amount}`, title: 'Another route' }
          ]));
      }
      const leg = both ? { from: mentioned.fromId, to: mentioned.toId } : null;
      if (!leg) {
        memory.setThread(hash, { intent: 'report', amount });
        state.parse = { ...c, intent: 'fare', via: 'report' };
        return void state.reply(wa.text(from, `Thanks for telling me 🙏 Which route was that ₵${amount} for? Send it like *Kaneshie to Circle*.`));
      }
      memory.setThread(hash, null);
      const r = await api.reportFare(leg.from, leg.to, amount, hash);
      state.parse = { ...c, intent: 'fare', places: [leg.from, leg.to], via: 'report' };
      if (!r) return void state.reply(wa.text(from, `Thanks 🙏 I don't have a recorded fare for that route yet, so I can't compare your ₵${amount} with anything — but it helps the next rider.`));
      return void state.reply(await h.fareReportReplies(from, r));
    }

    /* "i'm going to circle", "fare to madina" — ask where they start. */
    if (!mentioned) {
      const dest = destinationOnly(state.text);
      if (dest) {
        const st = api.station(dest.toId);
        const name = (st && st.name) || dest.toText;
        memory.setThread(hash, { intent: 'fare', toId: dest.toId, toText: name, fromId: null, fromText: null });
        state.parse = { ...c, intent: 'fare', places: [dest.toId], via: 'memory' };
        return void state.reply(h.whereCard(from, `Going to *${name}* — where are you starting from?\n\nType the station, like *Kaneshie*. Or tap *Share location* if you prefer.`));
      }
    }
    /* "save my route kaneshie to circle", or the first route after ADD MY ROUTE — keep it. */
    if (both && (c.saveRoute || (caps.has(hash, 'route') && !state.user.route))) {
      caps.add(hash, 'route');
      const f = api.fare(mentioned.fromId, mentioned.toId);
      if (f && f.kind === 'leg') {
        state.user.route = { from: f.from.id, to: f.to.to, fromName: f.from.name, toName: f.to.name, chart: f.to.chart };
        state.parse = { ...c, intent: 'addon_add', places: [mentioned.fromId, mentioned.toId] };
        return void state.reply(wa.buttons(from,
          `*Route saved — ${f.from.name} → ${f.to.name}* (${h.money(f.to.chart)}).\n\nNow just send *how much*, *queue*, or an amount like *10* and I will assume this route.`,
          [{ id: 'addon:list', title: 'My add-ons' }]));
      }
      state.parse = { ...c, intent: 'fare', places: [mentioned.fromId, mentioned.toId] };
      const card = await h.answerFare(from, hash, mentioned.fromId, mentioned.toId);
      return void state.reply(h.withNote(card, `I turned on *My route*, but there's no single trotro from *${h.placeName(mentioned.fromId)}* to *${h.placeName(mentioned.toId)}*, so I can't save it as your route. Here is how the trip is made:`));
    }
    if (both) {
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
    && (state.classified.intent === 'fare' || h.fareAsk(state.text)
      || (memory.thread(state.hash) && memory.thread(state.hash).intent === 'report')))
};

module.exports = { FareAmountNode, QuickReportNode, OpenRouteNode, FareMentionNode, when };
