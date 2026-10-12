/**
 * Start and finish of every run: bring in the chat memory, honour a delete,
 * and on the way out guard, decorate, and remember the reply.
 */
const { Node } = require('../../graph');
const wa = require('../../wa');
const caps = require('../../capabilities');
const memory = require('../../memory');
const talk = require('../../talk');
const h = require('../handlers');

class LoadNode extends Node {
  constructor() { super('load', { description: 'Read the chat memory and log the inbound message' }); }

  async run(state) {
    const s = state.user;
    if (!s.country && s.context && s.context.country) s.country = s.context.country;
    if (!s.awaitingCountry && s.context && s.context.awaitingCountry) s.awaitingCountry = s.context.awaitingCountry;
    if (!s.awaitingRoadWhere && s.context && s.context.awaitingRoadWhere) s.awaitingRoadWhere = s.context.awaitingRoadWhere;
    if (state.deleting) return;
    await memory.hydrate(state.hash);
    if (state.text) await memory.remember(state.hash, 'in', state.text, null);
    else if (state.location) await memory.remember(state.hash, 'in', 'shared a location', 'where');
  }
}

class ForgetNode extends Node {
  constructor() { super('forget', { description: 'DELETE MY DATA — wipe the subscriber and the chat memory' }); }

  async run(state) {
    caps.forget(state.hash);
    state.reply(wa.text(state.from, 'Your GH Fares data for this chat is deleted — add-ons, saved station, route, country, road photos, and the memory of this chat. Message history inside WhatsApp or Messenger is still held by Meta. Send *hi* if you want to start again.'));
  }
}

const FIGURE = /[₵¢]\s*\d|\d+(\.\d+)?\s*(cedis?|pesewas?|ghs)\b/i;

/* Chat has no data behind it, so it may never carry a fare or a price.
   Lookups are checked where they read the table; this is the backstop
   for every reply the chat node writes. */
class GuardNode extends Node {
  constructor() { super('guard', { description: 'A chat reply may not carry a fare or price figure' }); }

  async run(state) {
    if (state.source !== 'chat') return;
    const said = state.replies.map(h.replyText).join('\n');
    if (!FIGURE.test(said)) return;
    state.replies = [wa.text(state.from, talk.canned(state.text, state.prior))];
  }
}

class DecorateNode extends Node {
  constructor() { super('decorate', { description: 'Add the browser location link and the like / dislike buttons' }); }

  async run(state) {
    let payloads = await h.withLocationChoices(state.from, state.hash, state.replies, state.channel);
    payloads = h.withSignals(state.from, payloads);
    state.replies = payloads;
  }
}

class RememberNode extends Node {
  constructor() { super('remember', { description: 'Log the outbound reply in the chat memory' }); }

  async run(state) {
    if (state.deleting) return;
    const body = (state.replies || []).map(h.replyText).filter(Boolean).join('\n');
    if (body) await memory.remember(state.hash, 'out', body, state.parse.intent);
  }
}

module.exports = { LoadNode, ForgetNode, GuardNode, DecorateNode, RememberNode };
