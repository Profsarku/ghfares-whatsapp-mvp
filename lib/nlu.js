/**
 * Open-source NLU bridge.
 *
 * Regex handles the obvious phrases. This module maps the rest to
 * { intent, places, arg } — never a fare, fuel price, or other number.
 * Lookups stay in lib/api.js.
 *
 * Providers (env):
 *   NLU_PROVIDER=auto     try Ollama on localhost, else lexical (default)
 *   NLU_PROVIDER=ollama   Ollama only (http://127.0.0.1:11434)
 *   NLU_PROVIDER=openai   OpenAI-compatible host (Groq, Together, vLLM, LM Studio)
 *   NLU_PROVIDER=off      lexical examples only — tests, or no model installed
 *
 *   NLU_BASE_URL   override (Ollama default http://127.0.0.1:11434)
 *   NLU_MODEL      default llama3.2  (openai: llama-3.1-8b-instant)
 *   NLU_API_KEY    for Groq / Together / etc.
 *   NLU_TIMEOUT_MS default 45000 (first Llama load is slow)
 */
const examples = require('./nlu-examples.json');

const INTENTS = new Set([
  'addon_add', 'addon_remove', 'addon_list',
  'help', 'where', 'menu', 'greet',
  'incident_history', 'fuel', 'queue', 'road', 'cheapest', 'fare', 'station'
]);

const CAP_IDS = ['fuel', 'roads', 'route', 'queue', 'chart', 'report'];

function env(name, fallback) {
  const v = process.env[name];
  return v == null || v === '' ? fallback : v;
}

function provider() {
  return String(env('NLU_PROVIDER', 'auto')).toLowerCase();
}

function timeoutMs() {
  const n = Number(env('NLU_TIMEOUT_MS', '45000'));
  return Number.isFinite(n) && n > 0 ? n : 1800;
}

function tokens(s) {
  return String(s || '').toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
}

function overlap(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.max(A.size, B.size);
}

function lexicalMatch(text) {
  let best = null;
  let score = 0;
  for (const ex of examples) {
    const s = overlap(text, ex.text);
    if (s > score) { score = s; best = ex; }
  }
  if (!best || score < 0.42) return null;
  return {
    intent: best.intent,
    arg: best.arg || undefined,
    places: best.places || [],
    scope: best.scope || null,
    compare: !!best.compare,
    past: !!best.past,
    nlu: 'lexical',
    score
  };
}

function looksLikeAddonControl(text) {
  const t = String(text || '').toLowerCase();
  return /\b(switch on|switch off|turn on|turn off|enable|disable|subscribe|unsubscribe|opt in|opt out|alert me|notify me|watch|watching|remind|add[- ]?on)\b/.test(t);
}

function prompt(text, seed) {
  const placeHint = (seed.places || []).length
    ? `Places already extracted (keep unless wrong): ${seed.places.join(', ')}`
    : 'No places extracted yet. Only name places the user said.';
  const shots = examples.slice(0, 12).map(ex =>
    `- "${ex.text}" → ${JSON.stringify({ intent: ex.intent, arg: ex.arg || '', places: ex.places || [] })}`
  ).join('\n');
  return `You map Ghana transport chat to JSON for GH Fares.
Return ONLY JSON: {"intent":"","places":[],"arg":"","scope":null,"compare":false,"past":false}

Allowed intent: ${[...INTENTS].join(', ')}
arg only for addon_add / addon_remove, and only one of: ${CAP_IDS.join(', ')}
scope is "here" if they mean near me, else null.
places: station or city names from the user text only.

NEVER invent a fare, price, amount, or chart figure. Do not answer the question. Classify it.

${placeHint}

Examples:
${shots}

User: ${text}`;
}

function parseModelJson(raw) {
  const s = String(raw || '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); }
  catch { return null; }
}

function sanitize(hit, seed, nlu) {
  if (!hit || !INTENTS.has(hit.intent)) return null;
  const out = {
    intent: hit.intent,
    arg: undefined,
    places: Array.isArray(seed.places) ? seed.places.slice() : [],
    scope: hit.scope === 'here' ? 'here' : (seed.scope || null),
    compare: !!(hit.compare || seed.compare),
    past: !!(hit.past || seed.past),
    nlu
  };
  if (hit.intent === 'addon_add' || hit.intent === 'addon_remove') {
    const arg = String(hit.arg || '').toLowerCase().trim();
    out.arg = CAP_IDS.includes(arg) ? arg : arg;
  }
  if (Array.isArray(hit.places) && hit.places.length && !out.places.length) {
    out.places = hit.places.map(p => String(p || '').toLowerCase().trim()).filter(Boolean);
  }
  delete hit.amount;
  delete hit.price;
  delete hit.fare;
  return out;
}

async function fetchTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function ollamaChat(text, seed) {
  const base = env('NLU_BASE_URL', 'http://127.0.0.1:11434').replace(/\/$/, '');
  const model = env('NLU_MODEL', 'llama3.2');
  const r = await fetchTimeout(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: 'Return JSON only. Never invent prices.' },
        { role: 'user', content: prompt(text, seed) }
      ]
    })
  }, timeoutMs());
  if (!r.ok) throw new Error('ollama ' + r.status);
  const body = await r.json();
  return parseModelJson(body && body.message && body.message.content);
}

async function openaiChat(text, seed) {
  const base = env('NLU_BASE_URL', 'https://api.groq.com/openai/v1').replace(/\/$/, '');
  const model = env('NLU_MODEL', 'llama-3.1-8b-instant');
  const key = env('NLU_API_KEY', '');
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = 'Bearer ' + key;
  const r = await fetchTimeout(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Return JSON only. Never invent prices.' },
        { role: 'user', content: prompt(text, seed) }
      ]
    })
  }, timeoutMs());
  if (!r.ok) throw new Error('openai-nlu ' + r.status);
  const body = await r.json();
  const content = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
  return parseModelJson(content);
}

let ollamaKnown = null; // true | false | null
async function ollamaUp() {
  if (ollamaKnown != null) return ollamaKnown;
  const base = env('NLU_BASE_URL', 'http://127.0.0.1:11434').replace(/\/$/, '');
  try {
    const r = await fetchTimeout(base + '/api/tags', { method: 'GET' }, 2500);
    ollamaKnown = r.ok;
  } catch {
    ollamaKnown = false;
  }
  return ollamaKnown;
}

async function modelHit(text, seed) {
  const p = provider();
  if (p === 'off') return null;
  try {
    if (p === 'openai') return sanitize(await openaiChat(text, seed), seed, 'openai');
    if (p === 'ollama') return sanitize(await ollamaChat(text, seed), seed, 'ollama');
    if (p === 'auto') {
      if (!(await ollamaUp())) return null;
      return sanitize(await ollamaChat(text, seed), seed, 'ollama');
    }
  } catch (e) {
    console.warn('nlu model skipped', e.message || e);
  }
  return null;
}

/**
 * @param {string} text
 * @param {{ places?: string[], scope?: string|null, compare?: boolean, past?: boolean }} seed
 */
async function infer(text, seed = {}) {
  const model = await modelHit(text, seed);
  if (model) return model;
  const lex = lexicalMatch(text);
  if (lex) return sanitize(lex, seed, 'lexical');
  return null;
}

function status() {
  const p = provider();
  return {
    provider: p,
    model: env('NLU_MODEL', p === 'openai' ? 'llama-3.1-8b-instant' : 'llama3.2'),
    base: env('NLU_BASE_URL', p === 'openai' ? 'https://api.groq.com/openai/v1' : 'http://127.0.0.1:11434'),
    ollama: ollamaKnown
  };
}

module.exports = {
  INTENTS, infer, lexicalMatch, looksLikeAddonControl, status, sanitize, prompt
};
