/**
 * Resuming an open step. These run when the subscriber record says the last
 * reply asked a question — what a photo shows, where a road report is, which
 * pump, which station — and the new text is the answer.
 */
const { Node } = require('../../graph');
const wa = require('../../wa');
const { api } = require('../../api');
const h = require('../handlers');

class RoadReportStepNode extends Node {
  constructor() { super('road_report_step', { description: 'Answer to a road report question: what it shows, where, or the contractor' }); }

  async run(state) {
    const { from, hash, user: s } = state;
    const waiting = h.awaitingRoadWhere(s);
    const raw = String(state.text).trim();
    const low = raw.toLowerCase();
    if (waiting.step === 'kind') {
      if (h.isPlaceDecline(raw) || /^(skip|neither)$/i.test(raw)) {
        h.clearAwaitingRoadWhere(s);
        await api.setRoadKind({ photo_id: waiting.photo_id, report_id: waiting.report_id, photo_kind: 'not_road', road: waiting.road });
        return void state.reply(wa.buttons(from,
          'Skipped. The photo is on your history — send *MY PHOTOS*.',
          [{ id: 'menu', title: 'Main menu' }]));
      }
      const kind = /\b(accident|crash|collision|wreck)\b/.test(low) ? 'accident'
        : /\b(road|condition|pothole|block|flood)\b/.test(low) ? 'road_condition'
        : null;
      if (!kind) return void state.reply(await h.askRoadKind(from, s, waiting));
      await api.setRoadKind({ photo_id: waiting.photo_id, report_id: waiting.report_id, photo_kind: kind, road: waiting.road });
      return void state.reply(await h.askRoadWhere(from, s, { ...waiting, kind }));
    }
    if (waiting.step === 'contractor') {
      if (h.isPlaceDecline(raw) || /^(skip|none|n\/a|na|don't know|dont know|unknown|no idea)$/i.test(low)) {
        return void state.reply(await h.finishContractor(from, s, ''));
      }
      return void state.reply(await h.finishContractor(from, s, raw));
    }
    if (h.isPlaceDecline(raw)) return void state.reply(await h.askRoadWhereTyped(from, s));
    state.reply(await h.finishRoadWhere(from, hash, s, { where_text: raw }));
  }
}

class FuelPlaceNode extends Node {
  constructor() { super('fuel_place', { description: 'A map link for the pump that was asked about' }); }

  async run(state) {
    const s = state.user;
    const link = h.fuelLinkFromText(state.text);
    const st = (api.core.fuel.stations || []).find(x => x.id === s.context.awaitingFuelPlace);
    if (st && link) state.reply(await h.fuelPriceReplies(state.from, state.hash, st, link));
  }
}

class TypedPlaceNode extends Node {
  constructor() { super('typed_place', { description: 'The station name after "where are you?" — or let a new question through' }); }

  async run(state) {
    const placed = await h.handleTypedPlace(state.from, state.hash, state.user, state.text);
    if (placed) state.reply(placed);
  }
}

module.exports = { RoadReportStepNode, FuelPlaceNode, TypedPlaceNode };
