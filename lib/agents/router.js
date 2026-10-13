/**
 * Who answers this line — the chat agent or the data agent.
 *
 * Runs before anything is looked up, on the words alone. Small talk, a
 * question about the bot, or a feeling goes to chat without touching the
 * fare tables or the classifier model. Anything that names a place, asks for
 * a fare, stops, fuel, a road or a queue, answers an open question, or
 * points back at what was just shown ("that route") goes to data.
 *
 * The data agent can still hand a line back: when its classifier says the
 * line is not a lookup (`declined`), the chat agent answers it.
 */
const { classifyRegex, atStatement } = require('../api');
const topic = require('./topic');

const SMALL_TALK_LINE = /^(hi|hello|hey|yo|ei|chale|chaley|charlie|how far|hw far|how you dey|how be|how are you|how are you doing|how is your day|wassup|wasup|sup|what'?s up|good (morning|afternoon|evening|night)|morning|maakye|maaha|maadwo|ete sen|ɛte sɛn|wo ho te sen|wo ho te sɛn|i dey|i dey oo?|fine|i'?m fine|i am fine|all good|thanks|thank you|thx|medaase|akpe|nice one|cool|alright|ok|okay|lol|haha+|hmm+|sorry|bye|see you|goodnight)( (bro|boss|chale|charlie|my guy|gh fares|there|again|so much|a lot))?$/;
const ABOUT_BOT = /\b(who are you|what are you|who made you|who built you|where are you from|where you dey from|are you (a )?(bot|human|real|person)|can we (just )?talk|let'?s (just )?talk|talk to me|tell me about yourself|what'?s your name)\b/;
const VENTING = /\b(killing me|dey kill me|dey worry me|dey tire me|i tire|e no easy|e hard oo?|wahala too much|tired|exhausted|annoy\w*|frustrat\w*|rude|hate|sad|angry|vex\w*|stress\w*|bored|fed up|sick of|too much|chai|eish|lol|haha|funny|crazy|nonsense|suffer\w*)\b/;
const PERSONAL = /^(i|i'm|im|i am|i've|i had|i was|i feel|i think|i like|i love|i live|my|me|we|our)\b/;
const DATA_ASK = /\b(how much|fare (from|to)|what is the fare|price of (petrol|diesel|fuel|gas)|i paid|paid|i want|i need|i wan|looking for|find( me)?|going to|i'?m going|i am going|i dey go|report|where is|which (road|station|car|trotro)|show me|check|any wahala|is the road|road condition|queue|loading|route|interested in)\b/;
/* Intents the regex is sure of — commands and reports, never chat. */
const COMMANDS = new Set(['addon_add', 'addon_remove', 'addon_list', 'help', 'menu', 'where', 'road_history', 'incident_history']);

/* Data intents that may make one button on a chat reply. */
function chatOffer(intent) {
  if (intent === 'cheapest') return 'fare';
  return ['fare', 'fuel', 'road', 'queue', 'station'].includes(intent) ? intent : '';
}

function norm(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** "what stops are along that route", "which stops", "where does it stop". */
function stopsAsk(text) {
  const t = norm(text);
  if (!t || /^stop\b/.test(t)) return false;
  return /\bstops\b|\bwhich stop\b|\bwhere (does|do) (it|they|the car|the trotro|the bus) stop\b/.test(t)
    || /\b(dey|go) stop\b|\bwhere (e|it|the car|the trotro) (dey )?(stop|pass)\b|\b(dey|go) pass where\b/.test(t);
}

/**
 * @param {string} text
 * @param {{ topic?: object|null, busy?: boolean }} [ctx]
 * @returns {{ agent: 'chat'|'data', sure?: boolean, offer?: string, why: string }}
 */
function decide(text, ctx = {}) {
  const t = norm(text);
  if (!t) return { agent: 'data', why: 'no text' };
  if (SMALL_TALK_LINE.test(t) || ABOUT_BOT.test(t)) return { agent: 'chat', sure: true, why: 'small talk' };

  const out = classifyRegex(text);
  if (COMMANDS.has(out.intent)) return { agent: 'data', why: out.intent };
  if (out.reporting || atStatement(text) || stopsAsk(text)) return { agent: 'data', why: 'report, place, or stops' };
  if (out.amount != null && /^[\d.\s₵]+$/.test(t)) return { agent: 'data', why: 'an amount' };
  if (ctx.topic && topic.refersBack(t)) return { agent: 'data', why: 'refers to ' + ctx.topic.kind };
  if (DATA_ASK.test(t) || out.places.length >= 2) return { agent: 'data', why: 'asks for data' };

  if (VENTING.test(t) || (PERSONAL.test(t) && !out.places.length)) {
    /* An open question waits for its answer; only a sure line may talk over it. */
    if (ctx.busy) return { agent: 'data', why: 'open question' };
    return { agent: 'chat', offer: chatOffer(out.intent), why: 'feeling or story' };
  }
  return { agent: 'data', why: 'let the data agent read it' };
}

const DATA_TOOLS = new Set([
  'opensearch', 'plan_fare', 'fuel_prices', 'road_status', 'queue_status',
  'charts', 'needs', 'route_stops', 'at_place', 'resolve_place', 'addons'
]);

const DATA_INTENTS = new Set([
  'fare', 'fuel', 'road', 'road_history', 'queue', 'chart', 'cheapest',
  'station', 'incident_history', 'where', 'addon_add', 'addon_remove',
  'addon_list', 'help', 'stops'
]);

/** After the data agent read the line: is it not a lookup after all? */
function declined(text, classified, planned) {
  const intent = classified && classified.intent;
  if (intent === 'chat') return true;
  const calls = (planned && planned.calls) || [];
  if (calls.some(call => DATA_TOOLS.has(call.name))) return false;
  if (intent === 'greet') return !/^start$/i.test(String(text || '').trim());
  const conv = calls.find(call => call.name === 'conversation');
  if (conv) {
    const kind = (conv.arguments && conv.arguments.kind) || '';
    if (kind === 'menu' || kind === 'help' || kind === 'where') return false;
  }
  if (intent === 'menu' || intent === 'help') return false;
  if (!intent) return true;
  return !DATA_INTENTS.has(intent);
}

/* Talking over an open fare question needs a model that said chat — a guess
   must not swallow the answer the thread is waiting for. */
function sureDecline(classified) {
  const c = classified || {};
  return c.intent === 'chat' && c.nlu !== 'heuristic' && c.nlu !== 'lexical';
}

module.exports = { decide, declined, sureDecline, stopsAsk, chatOffer, SMALL_TALK_LINE };
