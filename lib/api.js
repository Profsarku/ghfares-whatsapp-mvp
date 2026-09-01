const core = require('../data/core.json');

/* Demo data ships with fixed timestamps. Rebase them to "now" at load so
   ages read correctly whatever day this runs. Production reads real clocks. */
(function rebaseClocks() {
  const now = Date.now();
  const ago = m => new Date(now - m * 60000).toISOString();
  core.incidents.forEach((i, idx) => { i.reported_at = ago([38, 12][idx] ?? 20); });
  Object.entries(core.queues).forEach(([k, q], idx) => { q.at = ago([9, 4, 16, 6][idx] ?? 10); });
})();

/* ─────────────── place lexicon ─────────────── */
/* Built from the real station and destination names in the survey data,
   so every place the fare table knows is a place the parser knows. */
const PLACES = {};
core.stations.forEach(s => {
  (s.aliases || []).forEach(a => (PLACES[a.toLowerCase()] = s.id));
  PLACES[s.name.toLowerCase()] = s.id;
  // short form: first significant word, if unambiguous
  const head = s.name.toLowerCase().split(/[\s,]+/)[0];
  if (head.length > 3 && !(head in PLACES)) PLACES[head] = s.id;
  // every destination is addressable too
  (s.fares || []).forEach(f => {
    const n = f.name.toLowerCase();
    if (!(n in PLACES)) PLACES[n] = f.to;
    const stripped = n.replace(/\s+(station|stn|junction|jct|last ?stop|market|mkt)\b.*$/, '').trim();
    if (stripped.length > 3 && !(stripped in PLACES)) PLACES[stripped] = f.to;
  });
});
Object.assign(PLACES, {
  bubuashie: 'bubiashie-station', bubiashie: 'bubiashie-station',
  osu: 'osu', kasoa: 'kasoa', lapaz: 'lapaz',
  adenta: 'adenta', mallam: 'mallam', odorkor: 'odorkor', '37': '37',
  kumasi: 'kumasi', ksi: 'kumasi', adum: 'kumasi', asafo: 'kumasi',
  tamale: 'tamale', accra: 'accra', achimota: 'accra', tudu: 'accra',
  'cape coast': 'capecoast', motorway: 'tema motorway',
  'tema motorway': 'tema motorway', 'moto way': 'tema motorway',
  ashaiman: 'tema motorway', atomic: 'madina'
});

/* ─────────────── classifier ───────────────
   Regex fast-path first. A model call happens only on a miss, and even
   then it may only return {intent, entities} — never a price. Every
   number in a reply comes from the API functions below. */
function classify(raw) {
  const t = String(raw || '').toLowerCase().replace(/[^\w\s₵.]/g, ' ').replace(/\s+/g, ' ').trim();
  const out = { intent: null, places: [], compare: false, scope: null, past: false, amount: null, raw, via: 'regex' };

  // Match longest aliases first, but return places in the order they were
  // SAID — "kaneshie to bubuashie" must not resolve as bubuashie → kaneshie.
  const found = [];
  for (const k of Object.keys(PLACES).sort((a, b) => b.length - a.length)) {
    const m = t.match(new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
    if (m && !found.some(f => f.id === PLACES[k])) found.push({ id: PLACES[k], at: m.index, len: k.length });
  }
  // drop matches swallowed by a longer alias at the same position
  found.sort((a, b) => a.at - b.at);
  out.places = found
    .filter((f, i) => !found.some((g, j) => j !== i && g.at <= f.at && g.at + g.len >= f.at + f.len && g.len > f.len))
    .map(f => f.id);
  if (/\b(my area|near me|around here|nearby|close by)\b/.test(t)) out.scope = 'here';
  if (/\b(compare|versus|vs|against|compared to|difference)\b/.test(t)) out.compare = true;
  out.past = /\b(last|latest|previous|recent|recently|yesterday|earlier|happened|tell me more|history)\b/.test(t);

  const num = t.match(/(?:^|\s)(\d+(?:\.\d+)?)(?:\s|$)/);
  if (num) out.amount = parseFloat(num[1]);

  // add-on commands take precedence over everything
  const addM = t.match(/^add\s*(.*)$/);
  if (addM) { out.intent = 'addon_add'; out.arg = addM[1].trim(); return out; }
  if (/^(remove|stop|drop)\s+/.test(t)) { out.intent = 'addon_remove'; out.arg = t.replace(/^(remove|stop|drop)\s+/, ''); return out; }
  if (/^(my addons|addons|add ons|what.s added|my adds)$/.test(t)) { out.intent = 'addon_list'; return out; }

  if (/^(help|keywords|commands|what can you do)\b/.test(t)) out.intent = 'help';
  else if (/^(where|where am i|find my station|locate)\b/.test(t)) out.intent = 'where';
  else if (/^menu\b/.test(t) && t.length < 18) out.intent = 'menu';
  else if (/\b(hi|hello|start|hey|good morning|good evening)\b/.test(t) && t.length < 18) out.intent = 'greet';
  else if (/\b(accident|crash|collision)\b/.test(t) && out.past) out.intent = 'incident_history';
  else if (/\b(fuel|petrol|diesel|pump|filling station)\b/.test(t)) out.intent = 'fuel';
  else if (/\b(queue|loading|bay)\b/.test(t)) out.intent = 'queue';
  else if (/\b(traffic|road|jam|accident|crash|block|closed|congestion|issue|happening)\b/.test(t)) out.intent = 'road';
  else if (/\b(cheap\w*|lowest|least|best price)\b/.test(t)) out.intent = 'cheapest';
  else if (/\b(fare|cost|charge|price|how much)\b/.test(t) || out.places.length >= 2) out.intent = 'fare';
  else if (out.places.length === 1) out.intent = 'station';

  if (!out.intent) {
    out.via = 'model';                       // where the LLM call goes
    out.intent = out.places.length >= 2 ? 'fare' : out.places.length ? 'station' : 'menu';
  }
  return out;
}

/* ─────────────── API surface ─────────────── */
const api = {
  /** GET /v1/stations/near */
  stationsNear(lat, lng) {
    let best = null, bd = Infinity;
    for (const s of core.stations) {
      const d = Math.hypot(s.lat - lat, s.lng - lng) * 111320;
      if (d < bd) { bd = d; best = s; }
    }
    return { station: best, metres: Math.round(bd), source: 'published', authority: 'GUMAP / GTFS stop set' };
  },

  /** GET /v1/stations/{id} */
  station(id) { return core.stations.find(s => s.id === id || s.aliases.includes(id)) || null; },

  /** City names ("Tema to Accra") are not station ids. Map them to intercity rows. */
  cityOf(id) {
    const s = String(id || '').toLowerCase();
    if (['accra', 'tema', 'kumasi', 'tamale', 'capecoast'].includes(s)) return s;
    if (s.includes('tema') && !s.includes('accra')) return 'tema';
    if (/(accra|kaneshie|circle|makola|nima|achimota)/.test(s)) return 'accra';
    return null;
  },

  /** GET /v1/stations/{id}/fares — the highest-value response in the product */
  stationFares(id) {
    const st = api.station(id); if (!st) return null;
    return {
      station: st,
      fares: st.fares.map(f => ({
        ...f,
        queue: core.queues[`${st.id}:${f.to}`] || null,
        gouging: core.gouging[`${st.id}:${f.to}`] || null,
        chart: f.chart,
        chart_ref: core.charts.find(c => c.id === f.chart_id)
      })),
      source: 'both', authority: 'GPRTU chart + rider reports', as_of: core.updated
    };
  },

  /** GET /v1/fares?from=&to= */
  fare(from, to) {
    const st = api.station(from);
    if (st) {
      const f = st.fares.find(x => x.to === to || x.name.toLowerCase() === String(to).toLowerCase());
      if (f) return {
        kind: 'leg', from: st, to: f,
        queue: core.queues[`${st.id}:${f.to}`] || null,
        gouging: core.gouging[`${st.id}:${f.to}`] || null,
        chart_ref: core.charts.find(c => c.id === f.chart_id),
        source: 'published', authority: 'GPRTU chart'
      };
    }
    const ic = core.intercity.find(r =>
      (r.from === from && r.to === to) || (r.from === to && r.to === from));
    if (ic) return { kind: 'intercity', route: ic, source: 'published', authority: 'Operator charts' };
    const cf = api.cityOf(from), ct = api.cityOf(to);
    if (cf && ct && cf !== ct) {
      const city = core.intercity.find(r =>
        (r.from === cf && r.to === ct) || (r.from === ct && r.to === cf));
      if (city) return { kind: 'intercity', route: city, source: 'published', authority: 'GPRTU / surveyed corridor' };
    }
    return null;
  },

  /** GET /v1/fares/cheapest */
  cheapest(from, to) {
    const r = api.fare(from, to);
    if (!r) return null;
    if (r.kind === 'intercity') {
      const best = r.route.options.reduce((a, b) => (a.amount <= b.amount ? a : b));
      return { ...r, best };
    }
    return r;
  },

  /** GET /v1/fuel */
  fuel(area) {
    const rows = core.fuel.stations
      .filter(s => !area || s.area.toLowerCase() === String(area).toLowerCase())
      .sort((a, b) => a.petrol - b.petrol);
    return { rows, window: core.fuel.window, source: 'both', authority: 'NPA window + rider confirmations' };
  },

  /** GET /v1/fuel/compare */
  fuelCompare(a, b) {
    const avg = (area, k) => {
      const l = core.fuel.stations.filter(s => s.area.toLowerCase() === area.toLowerCase());
      return l.length ? l.reduce((x, s) => x + s[k], 0) / l.length : null;
    };
    const pa = avg(a, 'petrol'), pb = avg(b, 'petrol');
    if (pa == null || pb == null) return null;
    return {
      a: { area: a, petrol: pa, diesel: avg(a, 'diesel') },
      b: { area: b, petrol: pb, diesel: avg(b, 'diesel') },
      gap: Math.abs(pa - pb), cheaper: pa < pb ? a : b,
      window: core.fuel.window, source: 'both', authority: 'NPA window + rider confirmations'
    };
  },

  /** GET /v1/incidents */
  incidents(road) {
    const l = core.incidents.filter(i =>
      i.status === 'live' && (!road || i.road.toLowerCase().includes(String(road).toLowerCase())));
    return { incidents: l, source: 'crowd', authority: 'rider reports + traffic probes' };
  },

  /** GET /v1/corridors/{id}/state */
  queue(stationId, dest) {
    const q = core.queues[`${stationId}:${dest}`];
    if (!q) return null;
    const ageMin = Math.round((Date.now() - Date.parse(q.at)) / 60000);
    return { ...q, age_min: ageMin, stale: ageMin > 30, source: 'crowd', authority: 'rider pings only' };
  },

  /** POST /v1/reports/fare */
  reportFare(stationId, dest, amount) {
    const key = `${stationId}:${dest}`;
    const st = api.station(stationId);
    const f = st && st.fares.find(x => x.to === dest);
    if (!f) return null;
    const g = core.gouging[key] || { avg_reported: f.chart, chart: f.chart, pct: 0, reports: 0 };
    const n = g.reports + 1;
    const avg = (g.avg_reported * g.reports + amount) / n;
    core.gouging[key] = {
      avg_reported: Math.round(avg * 100) / 100, chart: f.chart,
      pct: Math.round(((avg - f.chart) / f.chart) * 1000) / 10, reports: n
    };
    return { logged: amount, chart: f.chart, ...core.gouging[key], station: st.name, dest: f.name };
  },

  /** POST /v1/reports/queue */
  reportQueue(stationId, dest, state) {
    const key = `${stationId}:${dest}`;
    const prev = core.queues[key] || { pings: 0 };
    core.queues[key] = { state, at: new Date().toISOString(), pings: prev.pings + 1 };
    return { ...core.queues[key], key };
  },

  charts() { return core.charts; },
  core
};

module.exports = { classify, api, PLACES };
