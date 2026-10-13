/**
 * Conversation memory, per user.
 *
 * Every message belongs to a conversation, and every conversation belongs to
 * one user through their hash. A new conversation starts after a quiet gap
 * (CONVERSATION_IDLE_MIN, 30 minutes by default). The `conversations` Neon
 * database keeps each one as its own row with its turns; the row also keeps
 * the topics it covered and, once it ends, a short summary with no figures.
 *
 * The current conversation is what a reply reads as history. Earlier
 * conversations come back as their summaries, so the chat agent can say
 * "last time you checked Kaneshie to Makola", and "same route as last time"
 * can reopen the route the last one ended on.
 *
 * The open follow-up question (thread) stays in the `memory` database.
 * The process maps keep everything when Neon is off, including unit tests.
 */
const crypto = require('crypto');
const persist = require('./db/persist');

const threads = new Map();
const convs = new Map();
const PAST_KEEP = 5;

function idleMs() {
  const min = Number(process.env.CONVERSATION_IDLE_MIN);
  return (Number.isFinite(min) && min > 0 ? min : 30) * 60 * 1000;
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function slot(hash) {
  if (!convs.has(hash)) convs.set(hash, { current: null, past: [] });
  return convs.get(hash);
}

/* ── the open follow-up question ── */

function thread(hash) {
  return threads.get(hash) || null;
}

function setThread(hash, next) {
  if (!next) threads.delete(hash);
  else threads.set(hash, next);
}

/* ── summaries ── no figures, names and subjects only */

const SUBJECT = {
  fuel: 'fuel prices', road: 'road conditions', road_history: 'their road photos',
  incident_history: 'recent accidents', queue: 'a station queue', chart: 'fare charts',
  help: 'how to use GH Fares', addon_add: 'add-ons', addon_remove: 'add-ons', addon_list: 'add-ons',
  cheapest: 'the cheapest fares', chat: 'a chat', greet: 'a chat'
};

function summarize(c) {
  const topics = (c.topics || []).slice(0, 5);
  const subjects = [];
  for (const t of c.turns || []) {
    const s = t.direction === 'out' && SUBJECT[t.intent];
    if (s && !subjects.includes(s) && !(s === 'a chat' && topics.length)) subjects.push(s);
  }
  const parts = [...topics, ...subjects.slice(0, 4)];
  return parts.length ? parts.join('; ') : 'a short chat';
}

/* ── conversations ── */

function open(hash, channel, now) {
  const s = slot(hash);
  if (s.current) {
    s.current.summary = summarize(s.current);
    persist.saveConversation(s.current).catch(() => {});
    s.past.unshift({ ...s.current, turns: [] });
    s.past = s.past.slice(0, PAST_KEEP);
  }
  s.current = { id: newId(), hash, channel: channel || null, startedAt: now, lastAt: now, turns: [], topics: [], topic: null, summary: '' };
  return s.current;
}

/** The conversation this message belongs to — the open one, or a new one after a quiet gap. */
function conversationFor(hash, channel, now = Date.now()) {
  const c = slot(hash).current;
  if (c && now - c.lastAt <= idleMs()) return c;
  return open(hash, channel, now);
}

/** Load this user's latest conversations from Neon. Every message, so any instance sees the same one. */
async function hydrate(hash) {
  if (!hash) return;
  const [rows, pending] = await Promise.all([persist.loadConversations(hash), persist.loadThread(hash)]);
  if (pending && !threads.has(hash)) threads.set(hash, pending);
  if (!rows || !rows.length) return;
  const s = slot(hash);
  const [latest, ...older] = rows;
  if (!s.current || s.current.id !== latest.id || latest.lastAt > s.current.lastAt) s.current = latest;
  s.past = older.map(r => ({ ...r, summary: r.summary || summarize(r) }));
}

/**
 * Log one message on the user's current conversation.
 * @param {{ agent?: string, topic?: object|null, topicLabel?: string, channel?: string }} [extra]
 */
async function remember(hash, direction, body, intent, extra = {}) {
  const text = String(body || '').trim().slice(0, 1000);
  if (!hash || !text) return;
  const now = Date.now();
  const c = conversationFor(hash, extra.channel, now);
  const row = { direction, body: text, intent: intent || null, agent: extra.agent || null, at: new Date(now).toISOString() };
  c.turns.push(row);
  if (c.turns.length > 40) c.turns = c.turns.slice(-40);
  c.lastAt = now;
  if (extra.topic) c.topic = extra.topic;
  if (extra.topicLabel && !c.topics.includes(extra.topicLabel)) c.topics = [...c.topics, extra.topicLabel].slice(-8);
  c.summary = summarize(c);
  await persist.saveConversation(c);
  await persist.saveTurn(c, row);
  if (direction === 'out') await persist.saveThread(hash, thread(hash));
}

/** History of the current conversation — what a reply reads. */
function recent(hash, n = 8) {
  const c = slot(hash).current;
  if (!c || Date.now() - c.lastAt > idleMs()) return [];
  return c.turns.slice(-n);
}

/** The current conversation, or null after a quiet gap. */
function current(hash) {
  const c = slot(hash).current;
  return c && Date.now() - c.lastAt <= idleMs() ? c : null;
}

/** Earlier conversations, newest first: id, when, summary, and the topic each ended on. */
function past(hash, n = 3) {
  const s = slot(hash);
  const list = [...s.past];
  if (s.current && Date.now() - s.current.lastAt > idleMs()) list.unshift({ ...s.current, summary: summarize(s.current) });
  return list.slice(0, n).map(c => ({
    id: c.id, startedAt: c.startedAt, lastAt: c.lastAt, summary: c.summary || summarize(c), topic: c.topic || null
  }));
}

/** The topic the last conversation ended on — for "same route as last time". */
function lastTopic(hash) {
  const earlier = past(hash, 1)[0];
  return (earlier && earlier.topic) || null;
}

function forget(hash) {
  threads.delete(hash);
  convs.delete(hash);
}

module.exports = { thread, setThread, recent, current, past, lastTopic, forget, hydrate, remember, summarize, idleMs };
