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
    blurb: 'Incidents and congestion on the roads you actually use.',
    grants: ['roads.alerts', 'roads.history'],
    proactive: true,
    source: 'crowd',
    onAdd: 'I will message you when something blocks a road on your saved routes. Only when it changes — never a feed.'
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

/** In-memory subscriber store. Swap for Postgres in production. */
const subscribers = new Map(); // hash -> { hash, caps:Set, route, station, context, seen }

function subscriber(hash) {
  if (!subscribers.has(hash)) {
    subscribers.set(hash, {
      hash,
      caps: new Set(),
      route: null,        // { from, to, chart }
      station: null,      // station id
      context: null,      // last resolved entities, for follow-ups
      seen: Date.now()
    });
  }
  const s = subscribers.get(hash);
  s.seen = Date.now();
  return s;
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
  return subscribers.delete(hash);
}

module.exports = {
  CAPABILITIES, byId, byKeyword, setGrantHook,
  subscriber, add, remove, has, granted, list, audience, subscribers, forget
};
