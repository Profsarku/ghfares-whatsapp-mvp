/**
 * One node per classified intent. The intent router picks the node from
 * state.classified.intent; anything it does not know goes to fallback.
 */
const { Node } = require('../../graph');
const wa = require('../../wa');
const caps = require('../../capabilities');
const { api } = require('../../api');
const h = require('../handlers');

class IntentNode extends Node {
  /**
   * @param {string} name node name
   * @param {string[]} intents the classifier intents this node answers
   * @param {string} description
   */
  constructor(name, intents, description) {
    super(name, { description });
    this.intents = intents;
  }

  async run(state) {
    state.reply(await this.answer(state, state.classified, state.user));
  }

  // eslint-disable-next-line no-unused-vars
  answer(state, c, s) { return null; }
}

class AddonAddIntent extends IntentNode {
  constructor() { super('addon_add', ['addon_add'], 'ADD … — switch an add-on on'); }
  answer(state, c) { return h.addonAdd(state.from, state.hash, c.arg); }
}

class AddonRemoveIntent extends IntentNode {
  constructor() { super('addon_remove', ['addon_remove'], 'REMOVE … — switch an add-on off'); }
  answer(state, c) { return h.addonRemove(state.from, state.hash, c.arg); }
}

class AddonListIntent extends IntentNode {
  constructor() { super('addon_list', ['addon_list'], 'MY ADDONS'); }
  answer(state) { return h.addonList(state.from, state.hash); }
}

class MenuIntent extends IntentNode {
  constructor() { super('menu', ['greet', 'menu'], 'The main menu — not repeated within two minutes of a welcome'); }

  answer(state, c, s) {
    if (c.intent === 'greet' && s.onboarded && h.liveCountry(s) && s.welcomedAt && Date.now() - s.welcomedAt < 2 * 60 * 1000) {
      return wa.text(state.from, 'Tap *Choose* for add-ons, or ask in your own words — *what is the road condition right now*.');
    }
    s.onboarded = true;
    s.welcomedAt = Date.now();
    return h.startMenu(state.from, state.hash);
  }
}

class HelpIntent extends IntentNode {
  constructor() { super('help', ['help'], 'Keyword card'); }
  answer(state) { return h.keywordCard(state.from, state.hash); }
}

class WhereIntent extends IntentNode {
  constructor() { super('where', ['where'], 'Ask where they are'); }
  answer(state, c, s) { return h.askPlace(state.from, s, 'station'); }
}

class FuelIntent extends IntentNode {
  constructor() { super('fuel', ['fuel'], 'Pump prices from the NPA window and the fuel index'); }
  answer(state, c) { return h.answerFuel(state.from, state.hash, c); }
}

class RoadIntent extends IntentNode {
  constructor() { super('road', ['road'], 'Road status, or log a road report'); }

  async answer(state, c, s) {
    if (c.reporting) return h.handleRoadTextReport(state.from, state.hash, c, s, state.text);
    return h.answerRoad(state.from, state.hash, c);
  }
}

class RoadHistoryIntent extends IntentNode {
  constructor() { super('road_history', ['road_history'], 'MY PHOTOS — their road photo history'); }
  answer(state) { return h.answerRoadHistory(state.from, state.hash); }
}

class QueueIntent extends IntentNode {
  constructor() { super('queue', ['queue'], 'Loading-bay queue at a station'); }
  answer(state, c) { return h.answerQueue(state.from, state.hash, c); }
}

class ChartIntent extends IntentNode {
  constructor() { super('chart', ['chart'], 'Which fare charts are loaded'); }
  answer(state) { return h.answerCharts(state.from, state.hash); }
}

class CheapestIntent extends IntentNode {
  constructor() { super('cheapest', ['cheapest'], 'Cheapest destination from a station'); }

  answer(state, c, s) {
    if (!(c.places[0] || s.station)) return h.askPlace(state.from, s, 'fare');
    return h.answerCheapest(state.from, state.hash, c.places[0] || s.station, c.places[1]);
  }
}

class FareIntent extends IntentNode {
  constructor() { super('fare', ['fare'], 'The fare between two places, the saved route, or a station board'); }

  answer(state, c, s) {
    const { from, hash } = state;
    if (c.places.length >= 2) {
      // saving a route for the MY ROUTE add-on
      if (caps.has(hash, 'route') && !s.route) {
        const f = api.fare(c.places[0], c.places[1]);
        if (f && f.kind === 'leg') {
          s.route = { from: f.from.id, to: f.to.to, fromName: f.from.name, toName: f.to.name, chart: f.to.chart };
          return wa.buttons(from, `*Route saved — ${f.from.name} → ${f.to.name}* (${h.money(f.to.chart)}).\n\nNow just send *how much*, *queue*, or an amount like *10* and I will assume this route.`,
            [{ id: 'addon:list', title: 'My add-ons' }]);
        }
      }
      return h.answerFare(from, hash, c.places[0], c.places[1]);
    }
    if (s.route && caps.granted(hash, 'route.default')) return h.answerFare(from, hash, s.route.from, s.route.to);
    if (c.places.length === 1) return h.answerStationBoard(from, hash, c.places[0]);
    return h.askPlace(from, s, 'fare');
  }
}

class StationIntent extends IntentNode {
  constructor() { super('station', ['station'], 'Station board — destinations and fares'); }

  answer(state, c, s) {
    if (!c.places[0]) return h.askPlace(state.from, s, 'station');
    return h.answerStationBoard(state.from, state.hash, c.places[0]);
  }
}

class IncidentHistoryIntent extends IntentNode {
  constructor() { super('incident_history', ['incident_history'], 'Recent accidents on a road'); }
  answer(state, c) { return h.answerRoad(state.from, state.hash, c); }
}

class FallbackIntent extends IntentNode {
  constructor() { super('fallback', [], 'Nothing matched — ask back with the likely meanings'); }

  answer(state) {
    return h.clarify(state.from, state.hash, state.user, state.text);
  }
}

const INTENT_NODES = [
  AddonAddIntent, AddonRemoveIntent, AddonListIntent, MenuIntent, HelpIntent, WhereIntent,
  FuelIntent, RoadIntent, RoadHistoryIntent, QueueIntent, ChartIntent, CheapestIntent,
  FareIntent, StationIntent, IncidentHistoryIntent
].map(Intent => new Intent());

module.exports = { IntentNode, INTENT_NODES, FallbackIntent };
