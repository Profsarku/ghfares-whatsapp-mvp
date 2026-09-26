/**
 * Per-chat memory. The open follow-up and the message log live here.
 * Neon `memory` is the store when configured. The process map keeps the
 * same thread for the life of this server, including unit tests.
 */
const persist = require('./db/persist');

const threads = new Map();
const logs = new Map();
const hydrated = new Set();

function thread(hash) {
  return threads.get(hash) || null;
}

function setThread(hash, next) {
  if (!next) threads.delete(hash);
  else threads.set(hash, next);
}

function recent(hash, n = 8) {
  return (logs.get(hash) || []).slice(-n);
}

function forget(hash) {
  threads.delete(hash);
  logs.delete(hash);
  hydrated.delete(hash);
}

async function hydrate(hash) {
  if (!hash || hydrated.has(hash)) return;
  hydrated.add(hash);
  const loaded = await persist.loadMemory(hash);
  if (!loaded) return;
  if (!logs.has(hash)) logs.set(hash, loaded.messages || []);
  if (loaded.thread && !threads.has(hash)) threads.set(hash, loaded.thread);
}

async function remember(hash, direction, body, intent) {
  const text = String(body || '').trim().slice(0, 1000);
  if (!hash || !text) return;
  const row = { direction, body: text, intent: intent || null, at: new Date().toISOString() };
  const list = logs.get(hash) || [];
  list.push(row);
  logs.set(hash, list.slice(-40));
  await persist.saveMemoryMessage(hash, row, thread(hash));
}

module.exports = { thread, setThread, recent, forget, hydrate, remember };
