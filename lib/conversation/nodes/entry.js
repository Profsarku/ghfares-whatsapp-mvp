/**
 * What happens before the message is read as a question: the welcome event,
 * picking a country, a road photo, and a shared location pin.
 */
const { Node } = require('../../graph');
const wa = require('../../wa');
const countries = require('../../countries');
const memory = require('../../memory');
const crowd = require('../../crowd');
const { api } = require('../../api');
const h = require('../handlers');

class WelcomeRequestNode extends Node {
  constructor() { super('welcome_request', { description: 'Meta opened a chat with no thread yet — say welcome' }); }

  async run(state) {
    state.reply(await h.welcome(state.from, state.hash));
  }
}

class CountryTapNode extends Node {
  constructor() { super('country_tap', { description: 'A country was picked from the list' }); }

  async run(state) {
    const { from, hash, user: s } = state;
    const code = String(state.tap).split(':')[1];
    if (code === 'ask') return void state.reply(await h.askCountry(from, s));
    const row = h.setCountry(s, code);
    state.reply(await h.afterCountry(from, hash, s, row));
  }
}

/* Ice breakers arrive as their exact label and slash commands as /fare …;
   both become ordinary text here. "Change country" is answered on the spot. */
class PrepareTextNode extends Node {
  constructor() { super('prepare_text', { description: 'Expand ice breakers and slash commands; switch country' }); }

  async run(state) {
    const { from, hash, user: s } = state;
    let text = state.text;
    if (!text) return;
    const ice = h.ICE_MAP[String(text).trim().toLowerCase()];
    if (ice) text = ice;
    else if (String(text).trim().startsWith('/')) text = h.expandCommand(text);
    state.input.text = text;
    if (!countries.wantsSwitch(text)) return;
    const row = countries.resolve(text);
    if (row) {
      h.setCountry(s, row.iso);
      return void state.reply(await h.afterCountry(from, hash, s, row));
    }
    s.country = null;
    state.reply(await h.askCountry(from, s));
  }
}

class OnboardingNode extends Node {
  constructor() { super('onboarding', { description: 'No country yet — find it from a pin, a tap, or the typed name' }); }

  async run(state) {
    const { from, hash, user: s, text, location } = state;
    if (location) {
      const row = h.applyCountryFromCoords(s, location.latitude, location.longitude);
      if (!row) {
        h.setAwaitingCountry(s, true);
        return void state.reply(wa.text(from, 'I could not tell the country from that pin. Type the country, or share your WhatsApp location again.'));
      }
      if (!countries.isLive(row.iso)) return void state.reply(await h.noCountryData(from, s, row));
      s.onboarded = true;
      const near = api.stationsNear(location.latitude, location.longitude);
      if (near.station && !near.too_far) {
        return void state.reply(await h.finishPlace(from, hash, s, { places: [near.station.id], metres: near.metres }));
      }
      return void state.reply(await h.startMenu(from, hash));
    }
    if (state.tapParts[0] === 'place') return void state.reply(await h.askCountryTyped(from, s));
    if (text) {
      if (h.isPlaceDecline(text)) return void state.reply(await h.askCountryTyped(from, s));
      const row = countries.resolve(text);
      if (row) {
        h.setCountry(s, row.iso);
        return void state.reply(await h.afterCountry(from, hash, s, row));
      }
      if (h.awaitingCountry(s) && ((s.awaitingCountry || (s.context && s.context.awaitingCountry) || {}).typed)) {
        return void state.reply(wa.text(from, 'We don\'t have data for that country yet. Share your WhatsApp location, or type another country.'));
      }
    }
    state.reply(await h.askCountry(from, s));
  }
}

class CountryUnavailableNode extends Node {
  constructor() { super('country_unavailable', { description: 'The country has no data yet — offer another' }); }

  async run(state) {
    const { from, hash, user: s, text, location } = state;
    if (location) {
      const row = h.applyCountryFromCoords(s, location.latitude, location.longitude);
      if (row) return void state.reply(await h.afterCountry(from, hash, s, row));
      h.setAwaitingCountry(s, true);
      return void state.reply(wa.text(from, 'I could not tell the country from that pin. Type the country, or share your WhatsApp location again.'));
    }
    if (text) {
      if (h.isPlaceDecline(text)) return void state.reply(await h.askCountryTyped(from, s));
      const row = countries.resolve(text);
      if (row) {
        h.setCountry(s, row.iso);
        return void state.reply(await h.afterCountry(from, hash, s, row));
      }
    }
    state.reply(await h.noCountryData(from, s, countries.get(s.country)));
  }
}

class RoadPhotoNode extends Node {
  constructor() { super('road_photo', { description: 'A road photo — save it and ask what it shows or where' }); }

  async run(state) {
    state.reply(await h.handleRoadPhoto(state.from, state.hash, state.image || {}, state.user));
  }
}

/* A pin answers the open step first: a fare missing its origin, a road
   report missing its place, a local name waiting for a station. Otherwise it
   opens the nearest station. */
class LocationNode extends Node {
  constructor() { super('location', { description: 'A shared pin — finish the open step, else the nearest station' }); }

  async run(state) {
    const { from, hash, user: s, location } = state;
    const openFare = memory.thread(hash);
    if (openFare && openFare.intent === 'fare' && !openFare.fromId) {
      return void state.reply(await h.continueOpenRouteFromPin(from, hash, openFare, location));
    }
    const waitingRoad = h.awaitingRoadWhere(s);
    if (waitingRoad && waitingRoad.step !== 'kind') {
      return void state.reply(await h.finishRoadWhere(from, hash, s, {
        lat: location.latitude,
        lng: location.longitude,
        where_text: h.pinWhereText(location)
      }));
    }
    const atName = s.context && s.context.atName;
    if (atName) {
      const park = api.nearestFareStation(location.latitude, location.longitude);
      if (park) {
        await crowd.rememberName(atName, park.id, hash);
        s.context = { ...(s.context || {}) };
        delete s.context.atName;
        h.clearAwaitingPlace(s);
        const board = h.answerStationBoard(from, hash, park.id, park.metres);
        return void state.reply(await h.withNote(board, `*${atName}* is pending for *${park.name}*. Another rider at this station has to agree before everyone can use that name.`));
      }
    }
    const waiting = h.awaitingPlace(s);
    const reason = (waiting && waiting.reason) || 'station';
    const near = api.stationsNear(location.latitude, location.longitude);
    const limit = waiting ? 80000 : 25000;
    if (!near.station || near.metres == null || near.metres > limit) {
      const km = near.metres != null ? Math.round(near.metres / 1000) : null;
      const hint = near.station && km != null
        ? `That pin is about ${km} km from the nearest mapped station (*${near.station.name}*). `
        : '';
      h.setAwaitingPlace(s, reason, true);
      return void state.reply(wa.text(from, hint + 'Type the station name, or share again when you are at a station in this country.'));
    }
    state.reply(await h.finishPlace(from, hash, s, { places: [near.station.id], metres: near.metres }));
  }
}

module.exports = {
  WelcomeRequestNode, CountryTapNode, PrepareTextNode, OnboardingNode, CountryUnavailableNode,
  RoadPhotoNode, LocationNode
};
