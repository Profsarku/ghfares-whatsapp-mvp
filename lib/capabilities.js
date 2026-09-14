/**
 * CAPABILITIES — the "add-ons" system.
 *
 * WhatsApp has no extension store, so add-ons live here, on the server.
 * A user sends ADD FUEL and their subscriber record gains a capability.
 * From then on the bot behaves differently for them: new proactive
 * messages, new default context, new shortcuts.
 *
 * Functionally identical to an add-on. Needs no permission from Meta.
 */

const CAPABILITIES = [
  {
    id: 'fuel',
    keyword: 'FUEL',
    title: 'Fuel watch',
    blurb: 'Cheapest fuel near you, and an alert when a station near you changes price.',
    grants: ['fuel.nearby', 'fuel.alerts'],
    proactive: true,
    source: 'published',
    onAdd: 'I will check fuel prices around you and message you when a station near you moves its price.'
  },
  {
    id: 'roads',
    keyword: 'ROADS',
    title: 'Road alerts',
    blurb: 'Incidents and congestion on the roads you actually use. Send a photo from WhatsApp to report what you see.',
    grants: ['roads.alerts', 'roads.history'],
    proactive: true,
    source: 'crowd',
    onAdd: 'I will message you when something blocks a road on your saved routes. Send a photo from WhatsApp when you see it — that picture is the report.'
  },
  {
    id: 'route',
    keyword: 'MY ROUTE',
    title: 'My route',
    blurb: 'Save your daily route. Then "how much?" needs no origin or destination.',
    grants: ['route.default', 'route.queue', 'route.gouging'],
    proactive: false,
    source: 'both',
    onAdd: 'Saved. Now just send "how much" or "queue" and I will assume this route.'
  },
  {
    id: 'queue',
    keyword: 'QUEUE',
    title: 'Queue watch',
    blurb: 'Know before you walk whether your loading bay is moving.',
    grants: ['queue.alerts'],
    proactive: true,
    source: 'crowd',
    onAdd: 'I will tell you when the queue on your bay turns slow or stuck.'
  },
  {
    id: 'chart',
    keyword: 'CHART',
    title: 'Fare revisions',
    blurb: 'The moment GPRTU or an operator changes a chart, you get the new fare.',
    grants: ['chart.alerts'],
    proactive: true,
    source: 'published',
    onAdd: 'I will send you the new fares within hours of any chart revision on your routes.'
  },
  {
    id: 'report',
    keyword: 'REPORT',
    title: 'Quick report',
    blurb: 'One-word reporting. Send an amount and I know the route and station already.',
    grants: ['report.fast'],
    proactive: false,
    source: 'crowd',
    onAdd: 'Now just send a number, like 10, and I will log it against your saved route.'
  }
];

const byId = Object.fromEntries(CAPABILITIES.map(c => [c.id, c]));
const byKeyword = Object.fromEntries(CAPABILITIES.map(c => [c.keyword, c]));

const ARG_ALIASES = [
  ['fuel', ['fuel', 'petrol', 'diesel', 'pump', 'pumps', 'filling']],
  ['roads', ['road', 'roads', 'traffic', 'highway', 'motorway', 'incident']],
  ['route', ['route', 'commute', 'daily']],
  ['queue', ['queue', 'bay', 'loading']],
  ['chart', ['chart', 'gprtu', 'revision', 'fare alert']],
  ['report', ['report', 'paid', 'overcharge', 'gouging']]
];

function resolve(arg) {
  const s = String(arg || '').trim();
  if (!s) return null;
  const upper = s.toUpperCase();
  if (byKeyword[upper]) return byKeyword[upper];
  const lower = s.toLowerCase();
  if (byId[lower]) return byId[lower];
  for (const [id, keys] of ARG_ALIASES) {
    if (keys.some(k => lower.includes(k))) return byId[id];
  }
  return CAPABILITIES.find(c =>
    lower.includes(c.id) || c.title.toLowerCase().includes(lower) || lower.includes(c.title.toLowerCase())
  ) || null;
}

const persist = require('./db/persist');

/** In-memory subscriber store. Neon `users` is the durable copy when DATABASE_URL is set. */
const subscribers = new Map(); // hash -> { hash, caps:Set, route, station, context, seen }

function blank(hash) {
  return {
    hash,
    caps: new Set(),
    route: null,        // { from, to, chart }
    station: null,      // station id
    context: null,      // last resolved entities, for follow-ups
    pending: null,
    seen: Date.now(),
    welcomedAt: null,
    onboarded: false,
    lastIntent: null
  };
}

function fromRow(row) {
  const s = blank(row.hash);
  s.caps = new Set(row.caps || []);
  s.route = row.route || null;
  s.station = row.station || null;
  s.context = row.context || null;
  s.pending = row.pending || null;
  s.seen = row.seen ? Date.parse(row.seen) : Date.now();
  return s;
}

function subscriber(hash) {
  if (!subscribers.has(hash)) subscribers.set(hash, blank(hash));
  const s = subscribers.get(hash);
  s.seen = Date.now();
  return s;
}

let booted = null;
async function ready() {
  if (booted) return booted;
  booted = (async () => {
    const [users, sessions] = await Promise.all([persist.loadUsers(), persist.loadSessions()]);
    for (const row of users) {
      if (!subscribers.has(row.hash)) subscribers.set(row.hash, fromRow(row));
    }
    for (const row of sessions) {
      const s = subscribers.get(row.hash) || blank(row.hash);
      if (row.welcomed_at) s.welcomedAt = Date.parse(row.welcomed_at);
      s.onboarded = !!row.onboarded || !!s.welcomedAt;
      if (row.last_intent) s.lastIntent = row.last_intent;
      if (row.composer && !s.pending) s.pending = row.composer;
      subscribers.set(row.hash, s);
    }
  })();
  return booted;
}

async function ensure(hash, channel) {
  await ready();
  const s = subscriber(hash);
  await persist.saveIdentity(hash, channel);
  return s;
}

async function flush(hash, channel) {
  const s = subscribers.get(hash);
  if (!s) return;
  await Promise.all([
    persist.saveUser(s),
    persist.saveSession(s),
    persist.saveIdentity(hash, channel)
  ]);
}

/* Set by lib/broadcast.js at load. Every grant writes an opt-in row —
   this is the consent record Meta expects you to be able to produce. */
let onGrant = null;
function setGrantHook(fn) { onGrant = fn; }

function add(hash, capId, method = 'keyword') {
  const cap = byId[capId];
  if (!cap) return null;
  const s = subscriber(hash);
  const isNew = !s.caps.has(capId);
  s.caps.add(capId);
  if (isNew && onGrant) onGrant(hash, capId, method);
  return cap;
}

function remove(hash, capId) {
  const s = subscriber(hash);
  const had = s.caps.delete(capId);
  return had ? byId[capId] : null;
}

function has(hash, capId) {
  return subscriber(hash).caps.has(capId);
}

function granted(hash, grant) {
  const s = subscriber(hash);
  return [...s.caps].some(id => byId[id].grants.includes(grant));
}

function list(hash) {
  const s = subscriber(hash);
  return CAPABILITIES.map(c => ({ ...c, active: s.caps.has(c.id) }));
}

/** Everyone who has a capability and would receive a proactive push. */
function audience(capId) {
  return [...subscribers.values()].filter(s => s.caps.has(capId));
}

function forget(hash) {
  const gone = subscribers.delete(hash);
  persist.forget(hash).catch(e => console.error('neon forget', e.message || e));
  return gone;
}

module.exports = {
  CAPABILITIES, byId, byKeyword, resolve, setGrantHook,
  subscriber, add, remove, has, granted, list, audience, subscribers, forget,
  ready, ensure, flush
};
