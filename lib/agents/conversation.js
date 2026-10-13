/**
 * The conversation stage — every typed message passes here first, before an
 * open question or a lookup sees it. It owns the dialogue; the data agent
 * only ever receives a clean request.
 *
 *   "Great, I need help with getting fares"
 *     opener  "Great"            → acknowledged, not a place
 *     request "I need help with getting fares" → need: fare
 *
 * It decides what the message is:
 *   chat     small talk, a feeling, a question about earlier conversations
 *   answer   a short reply to the question the bot just asked ("kaneshie", "no")
 *   request  a new ask — any open question is closed first, so a sentence is
 *            never taken as the name of a place
 *   data     anything else the data agent should read as before
 *
 * Open questions also end with the conversation: after a quiet gap they are
 * dropped (lib/conversation/nodes/lifecycle.js), so a question from yesterday
 * cannot swallow today's first message.
 */
const router = require('./router');
const { classifyRegex } = require('../api');

/* Openers and acknowledgements that carry no request: "Great,", "ok so", "chale". */
const OPENER = /^(good (morning|afternoon|evening)|thank you|great|good|nice|fine|okay|ok|alright|cool|thanks|thank|thx|hello|hi|hey|yo|ei+|chaley|chale|charlie|boss|bro|sis|massa|please|pls|plz|abeg|so|well|yes|yeah|yep|hmm+|ah+|oh+)\b[\s,!.:;-]*/i;

/* What the request is for. Order matters: "help with getting fares" is a fare ask. */
const NEEDS = [
  ['stops', text => router.stopsAsk(text)],
  ['fare', text => /\b(fares?|fair|how much|hw much|trotro|tro tro|lorry|transport (cost|money|fare)|cost (to|from)|charge (to|from)|price (to|from)|dropping)\b/.test(text)],
  ['fuel', text => /\b(fuel|petrol|diesel|pump|filling station|gas price|goil)\b/.test(text)],
  ['queue', text => /\b(queue|loading bay|cars dey|line dey)\b/.test(text)],
  ['road', text => /\b(road (condition|status|report)|is the road|any wahala|accident on|traffic on|pothole)\b/.test(text)],
  ['help', text => /\b(help|how (do|does) (this|it|you) work|what can you do|how to use)\b/.test(text)]
];

function norm(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s'₵.]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Peel the opener off: "Great, I need fares" → { opener: 'Great', rest: 'I need fares' }. */
function split(text) {
  let rest = String(text || '').trim();
  const openers = [];
  for (let i = 0; i < 4; i++) {
    const m = rest.match(OPENER);
    if (!m || !m[0]) break;
    const after = rest.slice(m[0].length);
    /* "hi" alone, or "thanks so much" — the whole line is social. */
    if (!after.trim()) return { opener: [...openers, m[1]].join(' '), rest: '' };
    const next = String(m[1]).toLowerCase();
    if (next === 'so' && !openers.length) break;
    /* "good morning kaneshie" keeps the place; "fine" inside a sentence is not an opener. */
    if (!/[\s,!.:;-]$/.test(m[0]) && !/^[\s,!.:;-]/.test(after)) break;
    openers.push(m[1]);
    rest = after.trim();
  }
  return { opener: openers.join(' '), rest };
}

function needOf(text) {
  const t = norm(text);
  for (const [need, test] of NEEDS) if (test(t)) return need;
  return null;
}

function words(text) {
  const t = norm(text);
  return t ? t.split(' ').length : 0;
}

/** A reply that can answer "which place?" or "what did you pay?" — short, a place, a number, or a no. */
function answerShaped(text) {
  const t = norm(text);
  if (!t) return false;
  if (/^(no|nope|nah|skip|cancel|not now|later|none|i don'?t know|dont know)$/.test(t)) return true;
  if (/^[\d.\s₵]+$/.test(t)) return true;
  const out = classifyRegex(text);
  if (out.places.length && words(t) <= 6) return true;
  return words(t) <= 3 && !needOf(t);
}

/**
 * @param {string} text
 * @param {{ topic?: object|null, open?: boolean }} ctx  open: the bot is waiting on an answer
 * @returns {{ act: 'chat'|'answer'|'request'|'data', text: string, opener?: string, need?: string|null,
 *   close?: boolean, offer?: string, sure?: boolean, why: string }}
 */
function read(text, ctx = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { act: 'data', text: raw, why: 'no text' };
  /* The whole line first: "thanks so much" and "how far" are small talk as they stand. */
  const whole = router.decide(raw, { topic: ctx.topic });
  if (whole.agent === 'chat' && whole.sure) return { act: 'chat', text: raw, opener: '', sure: true, why: whole.why };

  const { opener, rest } = split(raw);

  if (!rest) return { act: 'chat', text: raw, opener, sure: true, why: 'only an opener' };

  if (ctx.open && answerShaped(rest)) return { act: 'answer', text: rest, opener, why: 'answers the open question' };

  const routed = router.decide(rest, { topic: ctx.topic });
  if (routed.agent === 'chat') {
    return { act: 'chat', text: raw, opener, offer: routed.offer, sure: routed.sure, why: routed.why };
  }

  const need = needOf(rest);
  if (need) return { act: 'request', text: rest, opener, need, close: !!ctx.open, why: 'asks for ' + need };

  /* A whole new sentence is not the name of a place. */
  if (ctx.open && words(rest) > 5) return { act: 'request', text: rest, opener, need: null, close: true, why: 'a new sentence' };

  return { act: 'data', text: rest, opener, why: routed.why };
}

module.exports = { read, split, needOf, answerShaped };
