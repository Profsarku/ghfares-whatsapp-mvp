/**
 * Button and list taps. The id is prefix:args — the router sends each prefix
 * to its own node. A tap node that does not recognise its arguments leaves
 * the state without replies, and the graph carries on as for any message.
 */
const { Node } = require('../../graph');
const wa = require('../../wa');
const caps = require('../../capabilities');
const memory = require('../../memory');
const crowd = require('../../crowd');
const fuelChecks = require('../../fuel-checks');
const { api } = require('../../api');
const h = require('../handlers');

class TapNode extends Node {
  /** @param {string} prefix the part of the tap id before the first ':' */
  constructor(prefix, description) {
    super(`tap_${prefix}`, { description });
    this.prefix = prefix;
  }

  async run(state) {
    const out = await this.handle(state, state.tapParts, state.user);
    if (out) state.reply(out);
  }

  /** @returns reply payloads, or nothing to let the message carry on */
  // eslint-disable-next-line no-unused-vars
  handle(state, p, s) { return null; }
}

class SignalTap extends TapNode {
  constructor() { super('sig', 'Like or dislike on a fare reply'); }

  async handle(state, p, s) {
    const { from, hash } = state;
    const routeKey = s.context && s.context.from && s.context.to
      ? `${s.context.from}:${s.context.to}`
      : state.parse.intent;
    await crowd.signal(hash, p[1] === 'down' ? 'down' : 'up', routeKey);
    const mine = crowd.score(hash);
    const fareCtx = s.context && s.context.from && s.context.to && api.fare(s.context.from, s.context.to);
    if (p[1] === 'down' && fareCtx && fareCtx.kind === 'leg') {
      s.pending = { from: s.context.from, to: fareCtx.to.to };
      return wa.text(from, `What did you actually pay? Send the amount only.\n\nYou are a *${mine.tier}*. A dislike does not change the fare until two other riders at that station agree.`);
    }
    return wa.text(from, `Noted. You are a *${mine.tier}*. A like or dislike does not change the fare.`);
  }
}

class FuelCheckTap extends TapNode {
  constructor() { super('fuelcheck', 'Agree or disagree with another rider\'s pump price'); }

  async handle(state, p) {
    const { from, hash } = state;
    const row = await fuelChecks.vote(p.slice(2).join(':'), hash, p[1] === 'yes');
    if (!row) return wa.text(from, 'That price check is no longer open.');
    if (row.hash === hash) return wa.text(from, 'You cannot confirm your own price check.');
    if (row.status === 'agreed') return wa.text(from, `Agreed. That pump now shows *${row.agrees.length}* rider confirmations. The index price did not change.`);
    if (row.status === 'contradicted') return wa.text(from, 'That price was contradicted. I will not show a confirmation count.');
    return wa.text(from, 'Noted. Still waiting for two other riders to agree.');
  }
}

class VerifyTap extends TapNode {
  constructor() { super('verify', 'Agree or disagree with another rider\'s fare, queue, or road report'); }

  async handle(state, p) {
    const { from, hash } = state;
    const row = await crowd.vote(p[2], hash, p[1] === 'yes');
    if (!row) return wa.text(from, 'That check has expired.');
    if (row.status === 'agreed') {
      if (row.kind === 'fare') {
        const agreed = await crowd.history(row.routeKey);
        const avg = agreed.reduce((sum, item) => sum + Number(item.amount), 0) / (agreed.length || 1);
        const pct = row.chart ? Math.round(((avg - row.chart) / row.chart) * 1000) / 10 : 0;
        api.core.gouging[row.routeKey] = {
          avg_reported: Math.round(avg * 100) / 100,
          chart: row.chart,
          pct,
          reports: agreed.length,
          agreed: true
        };
      }
      if (row.kind === 'queue') {
        api.core.queues[row.routeKey] = {
          state: row.detail,
          at: new Date().toISOString(),
          pings: row.agrees.length,
          agreed: true
        };
      }
      if (row.kind === 'road') {
        const inc = api.core.incidents.find(i => i.id === row.dest);
        if (inc) inc.confirmations = row.agrees.length;
      }
      const mine = crowd.score(hash);
      return wa.text(from, `Agreed. Riders at this station can see it now.\n\nYou are a *${mine.tier}* with *${mine.points}* points. The tier does not change the fare.`);
    }
    if (row.status === 'contradicted') return wa.text(from, 'That report was contradicted. It will not be shown as a percentage.');
    return wa.text(from, 'Noted. Still waiting for two riders at this station to agree.');
  }
}

class StopLegTap extends TapNode {
  constructor() { super('stopleg', 'Pick which route a stop is on'); }

  handle(state, p) {
    const [, fromId, toId, stopId] = p;
    const stop = (api.core.stops && api.core.stops[stopId]) || api.station(stopId);
    const endpoint = !!(stop && !(api.core.stops && api.core.stops[stopId]));
    const fare = h.answerFare(state.from, state.hash, fromId, toId);
    const label = (stop && stop.name) || 'that place';
    const note = endpoint
      ? `You are at *${label}*. This is the station-to-station fare for this leg.`
      : `You are at *${label}* on this route.\n\nThis is the station-to-station fare for the whole leg, not a fare from this stop.`;
    return h.withNote(fare, note);
  }
}

class DidYouMeanTap extends TapNode {
  constructor() { super('did', 'Answer to "Did you mean …?"'); }

  handle(state, p) {
    const { from, hash } = state;
    const open = memory.thread(hash);
    if (p[1] === 'no') {
      const phrase = open
        ? ((open.picking === 'to' ? open.toText : open.fromText) || 'that place')
        : 'that place';
      if (open) {
        open.naming = phrase;
        memory.setThread(hash, open);
      }
      crowd.signal(hash, 'unknown', phrase);
      return wa.locationRequest(from, `I do not have *${String(phrase).replace(/\*/g, '')}* on the map.\n\nShare where you are and I will attach that name to the nearest station. It stays pending until another rider there agrees.`);
    }
    const id = p.slice(1).join(':');
    const st = api.station(id);
    if (!st) return wa.text(from, 'That place is not on the map anymore. Name the station.');
    if (!open || open.intent !== 'fare') return h.answerStationBoard(from, hash, st.id);
    const slot = open.picking || (open.fromId ? 'to' : 'from');
    const applied = h.applyPlaceChoice(open, slot, { id: st.id, name: st.name, kind: 'station', lat: st.lat, lng: st.lng });
    return h.finishOpenRoute(from, hash, applied.next, applied.note);
  }
}

class MemoryChoiceTap extends TapNode {
  constructor() { super('mem', 'Pick a station or stop for the open fare question'); }

  handle(state, p) {
    const { from, hash } = state;
    const open = memory.thread(hash);
    if (!open) return wa.text(from, 'That choice expired. Send the route again, for example *Kaneshie to Circle*.');
    const slot = p[1] === 'to' ? 'to' : 'from';
    const kind = p[2];
    const id = p.slice(3).join(':');
    let choice = null;
    if (kind === 'stop') {
      const stop = api.core.stops && api.core.stops[id];
      if (stop) choice = { id: stop.id, name: stop.name, kind: 'stop', lat: stop.lat, lng: stop.lng };
    } else {
      const st = api.station(id);
      if (st) choice = { id: st.id, name: st.name, kind: 'station', lat: st.lat, lng: st.lng };
    }
    if (!choice) return wa.text(from, 'That place is not on the map anymore. Name the station.');
    const applied = h.applyPlaceChoice(open, slot, choice);
    return h.finishOpenRoute(from, hash, applied.next, applied.note);
  }
}

class AddonTap extends TapNode {
  constructor() { super('addon', 'Add-on menu, list, or switch one on'); }

  handle(state, p) {
    const { from, hash } = state;
    if (p[1] === 'menu') return h.addonMenu(from, hash);
    if (p[1] === 'list') return h.addonList(from, hash);
    if (p[1] === 'add') return h.addonAdd(from, hash, p.slice(2).join(':'));
    return h.addonAdd(from, hash, caps.byId[p[1]] ? caps.byId[p[1]].keyword : p[1]);
  }
}

class DestinationTap extends TapNode {
  constructor() { super('dest', 'A destination picked from a station board'); }

  handle(state, p) {
    return h.answerFare(state.from, state.hash, p[1], p[2]);
  }
}

class ReportTap extends TapNode {
  constructor() { super('report', 'Start a fare report — ask what they paid'); }

  handle(state, p, s) {
    const f = api.fare(p[1], p[2]);
    if (!f || f.kind !== 'leg') {
      return wa.text(state.from, 'I do not have that pair mapped yet — send the route and I will look it up.');
    }
    s.pending = { from: p[1], to: p[2] };
    return wa.text(state.from, `*Report a fare*\n\n${f.from.name} → ${f.to.name}\n${f.to.chart_status === 'estimate_pending_chart' ? 'Estimated' : 'Approved'}: *${h.money(f.to.chart)}*\n\nHow much were you charged? Send the amount only.`);
  }
}

class QueueTap extends TapNode {
  constructor() { super('queue', 'Ask about, or report, a loading-bay queue'); }

  async handle(state, p) {
    const { from, hash } = state;
    if (p[3]) {
      const r = await api.reportQueue(p[1], p[2], p[3], hash);
      const label = `${r.station || p[1]} → ${r.dest || p[2]}: ${p[3]}`;
      if (r.lone) {
        return wa.text(from, `Logged — *${label}*.\n\nYou are the only rider at this station right now, so this queue stays unverified.`);
      }
      const asks = (r.peers || []).map(peer => wa.buttons(peer.reach,
        `A rider at *${r.station || 'this station'}* says the queue to *${r.dest || p[2]}* is *${p[3]}*. Does that match?`,
        [{ id: `verify:yes:${r.reportId}`, title: 'Yes, it matches' }, { id: `verify:no:${r.reportId}`, title: 'No' }]));
      return [wa.text(from, `Logged — *${label}*.\n\nI asked *${r.peers.length}* rider${r.peers.length === 1 ? '' : 's'} at this station. It stays unverified until two of them agree.`), ...asks];
    }
    const qst = api.station(p[1]);
    const qdest = qst && qst.fares.find(f => f.to === p[2]);
    return wa.buttons(from, `*${qst ? qst.name : p[1]} → ${qdest ? qdest.name : p[2]}*\n\nHow is the queue right now?`, [
      { id: `queue:${p[1]}:${p[2]}:moving`, title: '🟢 Moving' },
      { id: `queue:${p[1]}:${p[2]}:slow`, title: '🟡 Slow' },
      { id: `queue:${p[1]}:${p[2]}:stuck`, title: '🔴 Stuck' }]);
  }
}

class FuelTap extends TapNode {
  constructor() { super('fuel', 'Fuel card for a pump'); }

  handle(state, p) {
    return h.answerFuel(state.from, state.hash, { places: [p[1]], compare: false, scope: null });
  }
}

class RoadTap extends TapNode {
  constructor() { super('road', 'Confirm or clear a road incident'); }

  async handle(state, p) {
    const { from, hash } = state;
    const inc = api.core.incidents.find(i => i.id === p[2]);
    if (p[1] === 'confirm' && inc) {
      const stationId = caps.subscriber(hash).station;
      if (!stationId) {
        return wa.text(from, `*${inc.road}* stays unverified until two other riders at your station agree. Tell me the station you are at first.`);
      }
      const filed = await crowd.fileReport({ kind: 'road', stationId, dest: inc.id, hash, detail: inc.road });
      if (filed.lone) {
        return wa.text(from, `*${inc.road}* is unverified. You are the only rider at this station right now, so I will not add a confirmation count.`);
      }
      const asks = filed.peers.map(peer => wa.buttons(peer.reach,
        `A rider at your station says *${inc.road}* is still blocked. Does that match?`,
        [{ id: `verify:yes:${filed.id}`, title: 'Yes, it matches' }, { id: `verify:no:${filed.id}`, title: 'No' }]));
      return [wa.text(from, `I asked *${filed.peers.length}* rider${filed.peers.length === 1 ? '' : 's'} about *${inc.road}*. It stays unverified until two of them agree.`), ...asks];
    }
    if (p[1] === 'clear' && inc) {
      inc.status = 'cleared';
      await api.reportRoad(inc.road, 'clear', {
        id: inc.id, kind: inc.kind, where: inc.where, delay: inc.delay,
        hash, status: 'cleared', confirmations: inc.confirmations
      });
      return wa.text(from, `Cleared — *${inc.road}* removed from live state on your report.\n\nOne rider on the spot beats an hour-old probe.`);
    }
    return null;
  }
}

class PhotoKindTap extends TapNode {
  constructor() { super('photo', 'What a road photo shows — road, accident, or skip'); }

  async handle(state, p, s) {
    if (p[1] !== 'kind') return null;
    const waiting = h.awaitingRoadWhere(s) || {};
    const kind = p[2];
    if (kind === 'skip') {
      h.clearAwaitingRoadWhere(s);
      await api.setRoadKind({ photo_id: waiting.photo_id, report_id: waiting.report_id, photo_kind: 'not_road', road: waiting.road });
      return wa.buttons(state.from,
        'Skipped. The photo is on your history — send *MY PHOTOS*. It will not go on the public roads list.',
        [{ id: 'menu', title: 'Main menu' }]);
    }
    await api.setRoadKind({ photo_id: waiting.photo_id, report_id: waiting.report_id, photo_kind: kind, road: waiting.road });
    return h.askRoadWhere(state.from, s, { ...waiting, kind });
  }
}

class LocationTap extends TapNode {
  constructor() { super('loc', 'Share location'); }

  handle(state, p, s) {
    if (h.awaitingRoadWhere(s)) return h.askRoadWhere(state.from, s, h.awaitingRoadWhere(s));
    return h.askPlace(state.from, s, 'station');
  }
}

class TypePlaceTap extends TapNode {
  constructor() { super('place', 'Type the place instead of sharing a pin'); }

  handle(state, p, s) {
    if (h.awaitingRoadWhere(s)) return h.askRoadWhereTyped(state.from, s);
    return h.askPlaceTyped(state.from, s, (h.awaitingPlace(s) && h.awaitingPlace(s).reason) || 'station');
  }
}

class MenuTap extends TapNode {
  constructor() { super('menu', 'Main menu'); }

  handle(state) { return h.startMenu(state.from, state.hash); }
}

class HelpTap extends TapNode {
  constructor() { super('help', 'Keyword card'); }

  handle(state) { return h.keywordCard(state.from, state.hash); }
}

class AskTap extends TapNode {
  constructor() { super('ask', 'Quick lookups: fuel near me, road conditions, a fare'); }

  handle(state, p, s) {
    if (p[1] === 'fuel') return h.answerFuel(state.from, state.hash, { places: [], compare: false, scope: 'here' });
    if (p[1] === 'road') return h.answerRoad(state.from, state.hash, { places: [], compare: false });
    return h.askPlace(state.from, s, 'fare');
  }
}

/* "Yes, I paid that" on the card that asks whether a bare amount was a fare. */
class PaidTap extends TapNode {
  constructor() { super('paid', 'Confirm that a bare amount was the fare paid on the route shown'); }

  async handle(state, p) {
    const [, fromId, toId, raw] = p;
    const amount = Number(raw);
    if (!fromId || !toId || !Number.isFinite(amount)) return null;
    const r = await api.reportFare(fromId, toId, amount, state.hash);
    if (!r) return wa.text(state.from, `Thanks 🙏 I don't have a recorded fare for that route yet, so I can't compare your ₵${amount} with anything.`);
    return h.fareReportReplies(state.from, r);
  }
}

/* "Another route" on that card — keep the amount and ask which route. */
class ReportRouteTap extends TapNode {
  constructor() { super('reportroute', 'The amount was for a different route — ask which one'); }

  handle(state, p) {
    const amount = Number(p[1]);
    if (!Number.isFinite(amount)) return null;
    memory.setThread(state.hash, { intent: 'report', amount });
    return wa.text(state.from, `Okay — which route was that ₵${amount} for? Send it like *Kaneshie to Circle*.`);
  }
}

class StopsTap extends TapNode {
  constructor() { super('stops', 'The stops on one leg, picked from a list'); }

  handle(state, p) {
    const [, fromId, toId] = p;
    const st = api.station(fromId);
    const leg = st && (st.fares || []).find(f => f.to === toId);
    if (!leg) return null;
    return h.answerStops(state.from, { fromId: st.id, toId: leg.to, fromText: st.name, toText: leg.name }, state.hash);
  }
}

class FareTap extends TapNode {
  constructor() { super('fare', 'The fare for one leg'); }

  handle(state, p) {
    const [, fromId, toId] = p;
    if (!fromId || !toId) return null;
    return h.answerFare(state.from, state.hash, fromId, toId);
  }
}

/* Buttons on a clarify card: what was just shown, taken one way or the other. */
class ContextTap extends TapNode {
  constructor() { super('ctx', 'Clarify — the stops or the fares for the station just shown'); }

  handle(state, p) {
    const [, what, stationId] = p;
    if (!stationId) return null;
    if (what === 'stops') return h.stopsPicker(state.from, state.hash, stationId);
    if (what === 'board') return h.answerStationBoard(state.from, state.hash, stationId);
    return null;
  }
}

class FuelStationTap extends TapNode {
  constructor() { super('fuelstation', 'Prices at one pump'); }

  handle(state, p) {
    const st = api.core.fuel.stations.find(x => x.id === p[1]);
    if (!st) return wa.text(state.from, 'That pump is not in the fuel index.');
    return h.fuelPriceReplies(state.from, state.hash, st);
  }
}

const TAPS = [
  SignalTap, FuelCheckTap, VerifyTap, StopLegTap, DidYouMeanTap, MemoryChoiceTap, AddonTap,
  DestinationTap, ReportTap, QueueTap, FuelTap, RoadTap, PhotoKindTap, LocationTap, TypePlaceTap,
  MenuTap, HelpTap, AskTap, FuelStationTap, StopsTap, FareTap, ContextTap, PaidTap, ReportRouteTap
].map(Tap => new Tap());

module.exports = { TapNode, TAPS };
