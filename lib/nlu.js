/**
 * Open-source Codex NLU (OpenAI gpt-oss, Apache-2.0).
 *
 * Regex handles structured commands, taps, and reports. Free-text
 * questions go to Codex first. This module maps them to
 * { intent, places, arg } — never a fare, fuel price, or other number.
 * Lookups stay in lib/api.js.
 *
 * Few-shots and the model endpoint live in the `ai` Neon database.
 * API keys stay in env (never in Postgres).
 *
 * Providers (env):
 *   NLU_PROVIDER=codex    gpt-oss via OpenAI-compatible API, else local Ollama (default)
 *   NLU_PROVIDER=auto     same as codex
 *   NLU_PROVIDER=ollama   Ollama only (http://127.0.0.1:11434, gpt-oss:20b)
 *   NLU_PROVIDER=openai   OpenAI-compatible host using NLU_BASE_URL / NLU_MODEL
 *   NLU_PROVIDER=off      lexical examples only — tests, or no model installed
 *
 *   NLU_BASE_URL   override the `ai.settings` endpoint
 *   NLU_MODEL      override the `ai.settings` model
 *   NLU_API_KEY    Hugging Face / Groq / Together token (HF_TOKEN also accepted)
 *   NLU_VISION_MODEL  vision model for road-photo accuracy (HF router)
 */
const examples = require('./nlu-examples.json');
const persist = require('./db/persist');

const INTENTS = new Set([
  'addon_add', 'addon_remove', 'addon_list',
  'help', 'where', 'menu', 'greet',
  'incident_history', 'road_history', 'fuel', 'queue', 'road', 'cheapest', 'fare', 'station', 'chart'
]);

const CAP_IDS = ['fuel', 'roads', 'route', 'queue', 'chart', 'report'];

const CODEX = {
  model: 'openai/gpt-oss-20b',
  base_url: 'https://router.huggingface.co/v1',
  timeout_ms: 8000,
  vision_model: 'Qwen/Qwen2.5-VL-7B-Instruct'
};

let shots = null;
let settings = null;
let gazetteer = [];
let readyOnce = null;
let ollamaKnown = null; // true | false | null

function env(name, fallback) {
  const v = process.env[name];
  return v == null || v === '' ? fallback : v;
}

function provider() {
  const p = String(env('NLU_PROVIDER', 'codex')).toLowerCase();
  return p === 'auto' ? 'codex' : p;
}

function apiKey() {
  return env('NLU_API_KEY', '') || env('HF_TOKEN', '');
}

function cfg() {
  const db = settings || {};
  const hosted = provider() !== 'ollama';
  return {
    model: env('NLU_MODEL', db.model || (hosted ? CODEX.model : 'gpt-oss:20b')),
    base_url: env('NLU_BASE_URL', db.base_url || (hosted ? CODEX.base_url : 'http://127.0.0.1:11434')),
    timeout_ms: Number(env('NLU_TIMEOUT_MS', String(db.timeout_ms || (hosted ? CODEX.timeout_ms : 45000)))),
    vision_model: env('NLU_VISION_MODEL', db.vision_model || CODEX.vision_model)
  };
}

function setGazetteer(rows) {
  gazetteer = Array.isArray(rows) ? rows : [];
}

function gazetteerBlock() {
  if (!gazetteer.length) return '';
  const names = gazetteer.slice(0, 400).map(p => {
    const extra = (p.aliases || []).filter(a => a && String(a).toLowerCase() !== String(p.name || '').toLowerCase()).slice(0, 2);
    return extra.length ? `${p.name} (${extra.join(', ')})` : p.name;
  }).filter(Boolean);
  return `Known stations and stops (put these names in places[] if the user said them). NEVER copy a fare, price, or amount from anywhere:\n${names.join('; ')}`;
}

function shotsList() {
  return shots && shots.length ? shots : examples;
}

function timeoutMs(fallback) {
  const n = Number(env('NLU_TIMEOUT_MS', String(fallback || cfg().timeout_ms || 8000)));
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
  for (const ex of shotsList()) {
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
  const list = shotsList();
  const shotsText = list.slice(0, 16).map(ex =>
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
${gazetteerBlock()}

Examples:
${shotsText}

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

function messageText(msg) {
  if (!msg) return '';
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map(p => typeof p === 'string' ? p : (p && (p.text || p.content)) || '').join('\n');
  }
  return String(msg.reasoning || msg.refusal || '');
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

function ollamaBase() {
  const u = env('NLU_BASE_URL', '');
  if (u && /127\.0\.0\.1|localhost/i.test(u)) return u.replace(/\/$/, '');
  return 'http://127.0.0.1:11434';
}

function ollamaModelName(model) {
  const m = String(model || '');
  if (/gpt-oss-120/.test(m)) return 'gpt-oss:120b';
  if (/gpt-oss/.test(m)) return 'gpt-oss:20b';
  if (m.includes(':') || !m.includes('/')) return m;
  return 'gpt-oss:20b';
}

async function ollamaChat(text, seed) {
  const base = ollamaBase();
  const model = ollamaModelName(cfg().model);
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
  }, timeoutMs(45000));
  if (!r.ok) throw new Error('ollama ' + r.status);
  const body = await r.json();
  return parseModelJson(body && body.message && body.message.content);
}

async function openaiChat(text, seed) {
  const c = cfg();
  const base = String(c.base_url || CODEX.base_url).replace(/\/$/, '');
  const model = c.model || CODEX.model;
  const key = apiKey();
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = 'Bearer ' + key;
  const r = await fetchTimeout(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      temperature: 0,
      reasoning_effort: 'low',
      messages: [
        { role: 'system', content: 'Return JSON only. Never invent prices.' },
        { role: 'user', content: prompt(text, seed) }
      ]
    })
  }, timeoutMs(c.timeout_ms || CODEX.timeout_ms));
  if (!r.ok) throw new Error('codex-nlu ' + r.status);
  const body = await r.json();
  const choice = body && body.choices && body.choices[0];
  return parseModelJson(messageText(choice && choice.message));
}

const ROAD_SEEN = new Set(['blocked', 'pothole', 'accident', 'flooded', 'slow', 'clear', 'other', 'none']);
const ROAD_ISSUE = new Set(['blocked', 'pothole', 'accident', 'flooded', 'slow']);

function visionPrompt(claimed, caption, road) {
  return `You check a transport photo for GH Fares.
The rider said the condition is "${claimed}"${road ? ` on "${road}"` : ''}${caption ? `. Caption: "${caption}"` : ''}.
Look at the image. Return ONLY JSON:
{"accurate":true,"seen":"blocked","kind":"road_condition","reason":"short why"}
seen must be one of: blocked, pothole, accident, flooded, slow, clear, other, none
kind must be one of: road_condition, accident, vehicle, not_road
- road_condition: pothole, flood, blocked carriageway, bad surface
- accident: crash, wreck, collision
- vehicle: a car/bus/trotro with no clear road damage
- not_road: not a road scene
accurate is true if the picture supports the claimed condition.
NEVER invent a fare, price, amount, or GPS. Do not describe people or plates.`;
}

function normalizeRoadCheck(raw, claimed, nlu) {
  if (!raw) return null;
  const seen = ROAD_SEEN.has(String(raw.seen || '').toLowerCase()) ? String(raw.seen).toLowerCase() : 'other';
  const kinds = new Set(['road_condition', 'accident', 'vehicle', 'not_road']);
  let kind = String(raw.kind || '').toLowerCase();
  if (!kinds.has(kind)) {
    if (seen === 'accident') kind = 'accident';
    else if (seen === 'none' || seen === 'other') kind = 'not_road';
    else kind = 'road_condition';
  }
  const claim = String(claimed || 'blocked').toLowerCase();
  let accurate = !!raw.accurate;
  if (seen === claim) accurate = true;
  else if (seen === 'none' || kind === 'not_road') accurate = false;
  else if (claim === 'clear') accurate = seen === 'clear';
  else if (ROAD_ISSUE.has(claim) && ROAD_ISSUE.has(seen)) accurate = true;
  const reason = String(raw.reason || '').replace(/\d/g, '').trim().slice(0, 160);
  return { accurate, seen, kind, reason, nlu };
}

async function reviewRoadPhoto({ bytes, mime, claimed, caption, road } = {}) {
  const p = provider();
  if (p === 'off') return null;
  const buf = bytes && (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  if (!buf || !buf.length || buf.length > 1.5 * 1024 * 1024) return null;
  const key = apiKey();
  if (!key && p !== 'ollama') return null;
  const c = cfg();
  const model = c.vision_model || CODEX.vision_model;
  const base = String(c.base_url || CODEX.base_url).replace(/\/$/, '');
  const dataUrl = `data:${mime || 'image/jpeg'};base64,${buf.toString('base64')}`;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = 'Bearer ' + key;
    const r = await fetchTimeout(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: 'Return JSON only. Never invent prices.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: visionPrompt(claimed, caption, road) },
              { type: 'image_url', image_url: { url: dataUrl } }
            ]
          }
        ]
      })
    }, timeoutMs(Math.max(c.timeout_ms || 8000, 12000)));
    if (!r.ok) throw new Error('vision ' + r.status);
    const body = await r.json();
    const choice = body && body.choices && body.choices[0];
    return normalizeRoadCheck(parseModelJson(messageText(choice && choice.message)), claimed, 'vision');
  } catch (e) {
    console.warn('nlu vision skipped', e.message || e);
    return null;
  }
}

async function ollamaUp() {
  if (ollamaKnown != null) return ollamaKnown;
  try {
    const r = await fetchTimeout(ollamaBase() + '/api/tags', { method: 'GET' }, 2500);
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
    if (p === 'codex') {
      if (apiKey()) {
        const hit = sanitize(await openaiChat(text, seed), seed, 'codex');
        if (hit) return hit;
      }
      if (await ollamaUp()) {
        return sanitize(await ollamaChat(text, seed), seed, 'codex-local');
      }
    }
  } catch (e) {
    console.warn('nlu model skipped', e.message || e);
  }
  return null;
}

async function ready() {
  if (readyOnce) return readyOnce;
  readyOnce = (async () => {
    await persist.seedAi(examples);
    const dbEx = await persist.loadAiExamples();
    if (dbEx && dbEx.length) shots = dbEx;
    const dbSet = await persist.loadAiSettings();
    if (dbSet && dbSet.model) settings = dbSet;
    if (!gazetteer.length) {
      const g = await persist.loadSurveyGazetteer();
      if (g.length) setGazetteer(g);
    }
  })();
  return readyOnce;
}

/**
 * @param {string} text
 * @param {{ places?: string[], scope?: string|null, compare?: boolean, past?: boolean }} seed
 */
async function infer(text, seed = {}) {
  await ready();
  const started = Date.now();
  const model = await modelHit(text, seed);
  const hit = model || (() => {
    const lex = lexicalMatch(text);
    return lex ? sanitize(lex, seed, 'lexical') : null;
  })();
  persist.saveAiCall({
    text,
    intent: hit && hit.intent,
    nlu: (hit && hit.nlu) || 'miss',
    places: (hit && hit.places) || seed.places || [],
    ms: Date.now() - started
  }).catch(() => {});
  return hit;
}

function status() {
  const p = provider();
  const c = cfg();
  return {
    provider: p,
    model: c.model,
    base: c.base_url,
    database: persist.enabled('ai'),
    gazetteer: gazetteer.length,
    survey: persist.enabled('survey'),
    vision: c.vision_model,
    ollama: ollamaKnown
  };
}

module.exports = {
  INTENTS, infer, lexicalMatch, looksLikeAddonControl, status, sanitize, prompt, ready, setGazetteer, reviewRoadPhoto
};
