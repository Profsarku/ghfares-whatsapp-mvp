/**
 * The state that flows through the conversation graph — one per inbound
 * message. Everything a node needs is here: the input, the subscriber
 * record (persisted by the checkpointer), the chat history, what the
 * classifier understood, and the replies so far.
 *
 * Replaces the old module-level `lastParse`, which two concurrent messages
 * could overwrite. Domain helpers that are deep in a call stack reach the
 * running state through AsyncLocalStorage (current / setParse / getParse),
 * so each request only ever sees its own.
 */
const { AsyncLocalStorage } = require('async_hooks');

const scope = new AsyncLocalStorage();

class ConversationState {
  /**
   * @param {{ from?: string, hash: string, text?: string, interactiveId?: string,
   *   location?: {latitude:number, longitude:number}, type?: string, channel?: string, image?: object }} input
   */
  constructor({ from, hash, text, interactiveId, location, type, channel, image } = {}) {
    this.from = from;
    this.hash = hash;
    this.channel = channel;
    /** What arrived. `text` may be rewritten once (ice breaker or slash command). */
    this.input = { text, interactiveId, location, type, image };
    /** Subscriber record — add-ons, country, and the open steps. Loaded and saved by the checkpointer. */
    this.user = null;
    /** "delete my data" — no memory is read or written for this message. */
    this.deleting = !!(text && /^(delete my data|forget me)$/i.test(String(text).trim()));
    /** Chat history before this message. */
    this.prior = [];
    /** What the classifier understood. Starts as a guess from the input kind. */
    this.parse = {
      intent: type || (interactiveId ? 'tap' : location ? 'where' : image ? 'road' : null),
      places: [],
      via: 'api'
    };
    /** Tool plan for the text, if any. */
    this.planned = null;
    /** The text is a fresh inquiry, not a follow-up to an open question. */
    this.inquiry = false;
    /** Reply payloads. A node that sets them ends the routing. */
    this.replies = [];
    this.done = false;
    /** Nodes visited, in order, with timings. */
    this.trace = [];
  }

  get text() { return this.input.text; }
  get tap() { return this.input.interactiveId; }
  get location() { return this.input.location; }
  get image() { return this.input.image; }
  get type() { return this.input.type; }

  /** A tap split on ':' — ['dest', 'kaneshie', 'circle']. */
  get tapParts() { return this.tap ? String(this.tap).split(':') : []; }

  update(patch) {
    Object.assign(this, patch);
    return this;
  }

  /** Set the replies for this message. Accepts one payload or a list. */
  reply(payloads) {
    const list = Array.isArray(payloads) ? payloads : [payloads];
    this.replies = list.filter(Boolean);
    this.done = true;
    return this;
  }

  /** Run fn with this state as the current one for helpers deep in the call stack. */
  scoped(fn) {
    return scope.run(this, fn);
  }
}

function current() {
  return scope.getStore() || null;
}

function setParse(parse) {
  const state = current();
  if (state) state.parse = parse;
}

function getParse() {
  const state = current();
  return (state && state.parse) || { intent: null, places: [], via: 'api' };
}

module.exports = { ConversationState, current, setParse, getParse };
