const core = require('../data/core.json');
const nlu = require('./nlu');
const persist = require('./db/persist');

/* Seed incidents keep dated clocks. Seed queues are demo state — do not
   present them as live. Production overlay fills queues from Neon. */
(function rebaseClocks() {
  const now = Date.now();
  const ago = m => new Date(now - m * 60000).toISOString();
  core.incidents.forEach((i, idx) => { i.reported_at = ago([38, 12][idx] ?? 20); });
  core.queues = {};
})();

/* ─────────────── place lexicon ─────────────── */
/* Built from the real station and destination names in the survey data,
   so every place the fare table knows is a place the parser knows. */
const PLACES = {};
const PLACE_OVERRIDES = {
  bubuashie: 'bubiashie-station', bubiashie: 'bubiashie-station',
  osu: 'osu', kasoa: 'kasoa', lapaz: 'lapaz',
  adenta: 'adenta', mallam: 'mallam', odorkor: 'odorkor', '37': '37',
  kumasi: 'kumasi', ksi: 'kumasi', adum: 'kumasi', asafo: 'kumasi',
  tamale: 'tamale', accra: 'accra', achimota: 'accra', tudu: 'accra',
  'cape coast': 'capecoast', motorway: 'tema motorway',
  'tema motorway': 'tema motorway', 'moto way': 'tema motorway',
  ashaiman: 'tema motorway', atomic: 'madina'
};

function rebuildPlaces() {
  for (const k of Object.keys(PLACES)) delete PLACES[k];
  Object.assign(PLACES, PLACE_OVERRIDES);
  const isStationId = id => (core.stations || []).some(s => s.id === id);
  const ranked = [...(core.stations || [])].sort((a, b) => String(a.name || '').length - String(b.name || '').length);
  ranked.forEach(s => {
    (s.aliases || []).forEach(a => (PLACES[String(a).toLowerCase()] = s.id));
    PLACES[s.name.toLowerCase()] = s.id;
    const head = s.name.toLowerCase().split(/[\s,]+/)[0];
    if (head.length > 3 && !isStationId(PLACES[head])) PLACES[head] = s.id;
    (s.fares || []).forEach(f => {
      const n = String(f.name || '').toLowerCase();
      if (n && !isStationId(PLACES[n])) PLACES[n] = f.to;
      const stripped = n.replace(/\s+(station|stn|junction|jct|last ?stop|market|mkt)\b.*$/, '').trim();
      if (stripped.length > 3 && !isStationId(PLACES[stripped])) PLACES[stripped] = f.to;
    });
  });
}

rebuildPlaces();

function resolvePlaceToken(token) {
  const k = String(token || '').toLowerCase().trim();
  if (!k) return null;
  if (PLACES[k]) return PLACES[k];
  if (core.stations.some(s => s.id === k)) return k;
  for (const name of Object.keys(PLACES).sort((a, b) => b.length - a.length)) {
    if (k.includes(name) || name.includes(k)) return PLACES[name];
  }
  return null;
}

function mergePlaces(existing, extra) {
  const out = Array.isArray(existing) ? existing.slice() : [];
  for (const p of extra || []) {
    const id = resolvePlaceToken(p) || (out.includes(p) ? p : null);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/* ─────────────── classifier ───────────────
   Structured commands stay on regex. Questions go to Codex first.
   The model may only return {intent, entities} — never a price. */
function isFareTalk(t) {
  return /\b(fare|paid|paying|charge|charged|how much|₵|cedi|trotro money)\b/.test(t);
}

function isRoadAsk(t) {
  return /\b(what is the road|road condition|what.?s happening|any wahala|how is the (road|traffic|highway|motorway)|is the (road|highway|motorway|traffic))\b/.test(t)
    || (/\b(what|how is|any|happening|right now|currently)\b/.test(t)
      && /\b(road|traffic|highway|motorway|condition|issue)\b/.test(t)
      && !/\b(pothole|i want to report|let me report|report it)\b/.test(t));
}

function isRoadReport(t) {
  if (isFareTalk(t) || isRoadAsk(t)) return false;
  return /\b(pothole|pot[- ]?hole|ditch|diversion|flood|flooded|i want to report|let me report|report it( myself)?|report the road|i (can )?see)\b/.test(t)
    || (/\b(blocked|blockage|crash|accident|jam|congestion)\b/.test(t) && !/\b(what|how is|any wahala)\b/.test(t));
}

function classifyRegex(raw) {
  const t = String(raw || '').toLowerCase().replace(/[^\w\s₵.]/g, ' ').replace(/\s+/g, ' ').trim();
  const out = { intent: null, places: [], compare: false, scope: null, past: false, amount: null, arg: undefined, reporting: false, raw, via: 'regex' };

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
  else if (/^(my (road )?photos|my (road )?reports|my history|photo history|my road history)$/.test(t)) out.intent = 'road_history';
  else if (/\b(accident|crash|collision)\b/.test(t) && out.past) out.intent = 'incident_history';
  else if (/\b(fuel|petrol|diesel|pump|filling station)\b/.test(t)) out.intent = 'fuel';
  else if (/\b(queue|loading|bay)\b/.test(t) && !isRoadReport(t)) out.intent = 'queue';
  else if (isRoadReport(t) || /\b(traffic|road|jam|accident|crash|block|closed|congestion|issue|happening|pothole|highway|motorway)\b/.test(t)) {
    out.intent = 'road';
    out.reporting = isRoadReport(t);
  }
  else if (/\b(fare chart|gprtu chart|chart revision|approved chart|what chart)\b/.test(t)) out.intent = 'chart';
  else if (/\b(cheap\w*|lowest|least|best price)\b/.test(t)) out.intent = 'cheapest';
  else if (/\b(fare|cost|charge|price|how much)\b/.test(t) || out.places.length >= 2) out.intent = 'fare';
  else if (out.places.length === 1) out.intent = 'station';

  return out;
}

function heuristicIntent(out) {
  out.via = 'model';
  out.nlu = 'heuristic';
  out.intent = out.places.length >= 2 ? 'fare' : out.places.length ? 'station' : 'menu';
  return out;
}

/* Commands, taps, and reports stay on the regex defaults. Free-text
   questions go to Codex first; lookups still run from the API after. */
function isStructuredCommand(raw, out) {
  const t = String(raw || '').trim().toLowerCase();
  if (!t) return true;
  if (out.amount != null && /^[\d.\s₵]+$/.test(t)) return true;
  if (out.reporting) return true;
  if (out.intent === 'addon_add' || out.intent === 'addon_remove' || out.intent === 'addon_list') return true;
  if (out.intent === 'greet' || out.intent === 'menu' || out.intent === 'help') return true;
  if (/^(where|where am i|find my station|locate)$/.test(t)) return true;
  if (/^(change|switch) country$/.test(t) || /^country$/.test(t)) return true;
  if (/^(my (road )?photos|my (road )?reports|my history|photo history|my road history)$/.test(t)) return true;
  if (/^(fare|fuel|roads?|queue|chart|menu|help|where)$/.test(t)) return true;
  return false;
}

async function classify(raw) {
  await ready();
  const out = classifyRegex(raw);
  if (isStructuredCommand(raw, out)) return out;

  const hit = await nlu.infer(String(raw || ''), {
    places: out.places,
    scope: out.scope,
    compare: out.compare,
    past: out.past
  });
  if (hit && hit.intent) {
    out.intent = hit.intent;
    out.via = 'model';
    out.nlu = hit.nlu;
    if (hit.arg) out.arg = hit.arg;
    if (hit.scope) out.scope = hit.scope;
    out.compare = !!(hit.compare || out.compare);
    out.past = !!(hit.past || out.past);
    out.places = mergePlaces(out.places, hit.places);
    if (out.intent === 'road') out.reporting = !!(out.reporting || isRoadReport(raw));
    return out;
  }
  if (out.intent) return out;
  return heuristicIntent(out);
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
    return { station: best, metres: Math.round(bd), too_far: bd > 25000, source: 'published', authority: 'GUMAP / GTFS stop set' };
  },

  /** GET /v1/stations/{id} */
  station(id) {
    const k = String(id || '').toLowerCase();
    if (!k) return null;
    const mapped = PLACES[k];
    return core.stations.find(s =>
      s.id === id || s.id === k || s.id === mapped
      || (s.aliases || []).some(a => String(a).toLowerCase() === k)
    ) || null;
  },

  stationBySlug(slug) {
    const k = String(slug || '').toLowerCase().trim();
    if (!k) return null;
    return api.station(k) || api.station(k.replace(/-/g, ' ')) || core.stations.find(s => {
      const id = String(s.id || '').toLowerCase();
      const name = String(s.name || '').toLowerCase().replace(/[\s,]+/g, '-');
      if (id === k || name === k) return true;
      return (s.aliases || []).some(a => String(a).toLowerCase().replace(/[\s,]+/g, '-') === k);
    }) || null;
  },

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
      source: core.survey && core.survey.loaded ? 'survey' : 'published',
      authority: (st.fares || []).some(f => f.chart_status === 'estimate_pending_chart')
        ? 'Accra TroTro Apps Challenge 2015 (rebased estimate — not an approved GPRTU chart)'
        : 'GPRTU chart + rider reports',
      as_of: core.updated
    };
  },

  /** GET /v1/fares?from=&to= */
  fare(from, to) {
    const st = api.station(from);
    const destId = resolvePlaceToken(to) || String(to || '').toLowerCase();
    const want = String(to || '').toLowerCase();
    if (st) {
      const f = st.fares.find(x =>
        x.to === to || x.to === destId
        || String(x.name || '').toLowerCase() === want
        || String(x.name || '').toLowerCase().includes(want)
        || String(x.to || '').toLowerCase() === want
      );
      if (f) return {
        kind: 'leg', from: st, to: f,
        queue: core.queues[`${st.id}:${f.to}`] || null,
        gouging: core.gouging[`${st.id}:${f.to}`] || null,
        chart_ref: core.charts.find(c => c.id === f.chart_id),
        source: core.survey && core.survey.loaded ? 'survey' : 'published',
        authority: f.chart_status === 'estimate_pending_chart'
          ? 'Accra TroTro Apps Challenge 2015 (rebased estimate — not an approved GPRTU chart)'
          : 'GPRTU chart'
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
      i.status === 'live' && !i.sample && (!road || i.road.toLowerCase().includes(String(road).toLowerCase())));
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
  async reportFare(stationId, dest, amount, hash) {
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
    await persist.saveFareReport({
      route_key: key, station_id: stationId, dest, amount, chart: f.chart, hash,
      aggregate: core.gouging[key]
    });
    return { logged: amount, chart: f.chart, ...core.gouging[key], station: st.name, dest: f.name };
  },

  /** POST /v1/reports/queue */
  async reportQueue(stationId, dest, state, hash) {
    const key = `${stationId}:${dest}`;
    const prev = core.queues[key] || { pings: 0 };
    const at = new Date().toISOString();
    core.queues[key] = { state, at, pings: prev.pings + 1 };
    await persist.saveQueue({
      route_key: key, station_id: stationId, dest, state, hash,
      pings: core.queues[key].pings, at
    });
    return { ...core.queues[key], key };
  },

  /** POST /v1/reports/road */
  async reportRoad(road, condition, extra = {}) {
    const name = String(road || '').trim();
    const cond = String(condition || '').trim().toLowerCase();
    if (!name || !cond) return null;
    const status = extra.status || (cond === 'clear' || cond === 'cleared' ? 'cleared' : 'live');
    const saved = await persist.saveRoadCondition({
      road: name,
      condition: cond,
      kind: extra.kind || cond,
      where_text: extra.where || extra.where_text || '',
      delay: extra.delay || '',
      hash: extra.hash,
      status,
      confirmations: extra.confirmations,
      photo_id: extra.photo_id || null,
      check_accurate: extra.check_accurate,
      check_seen: extra.check_seen,
      check_nlu: extra.check_nlu,
      photo_kind: extra.photo_kind || null
    });
    const id = 'rrc:' + (saved && saved.road_key || name.toLowerCase().replace(/\s+/g, '-'));
    let inc = core.incidents.find(i => i.id === extra.id || i.id === id
      || String(i.road).toLowerCase() === name.toLowerCase());
    if (!inc) {
      inc = { id, road: name, where: '', delay: '', confirmations: 0, source: 'crowd' };
      core.incidents.unshift(inc);
    }
    inc.kind = extra.kind || cond;
    inc.where = extra.where || inc.where || '';
    inc.delay = extra.delay || inc.delay || '';
    inc.status = status;
    inc.reported_at = new Date().toISOString();
    inc.sample = false;
    if (extra.confirmations != null) inc.confirmations = extra.confirmations;
    if (extra.photo_id) inc.photo_id = extra.photo_id;
    if (extra.photo_kind) inc.photo_kind = extra.photo_kind;
    if (extra.contractor) inc.contractor = extra.contractor;
    return { ...inc, logged: cond, photo_id: extra.photo_id || (saved && saved.photo_id) || null, report_id: saved && saved.id };
  },

  async reportRoadPhoto({ road, condition, caption, mime, bytes, wa_media_id, hash, where } = {}) {
    const name = String(road || 'unspecified road').trim() || 'unspecified road';
    const cond = String(condition || 'blocked');
    const buf = bytes && (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
    let photo = null;
    let check = null;
    if (buf && buf.length) {
      check = await nlu.reviewRoadPhoto({
        bytes: buf, mime, claimed: cond, caption, road: name
      });
      photo = await persist.saveRoadPhoto({
        road: name, condition: cond, caption, mime, bytes: buf, wa_media_id, hash
      });
      if (photo && photo.id && check) await persist.saveRoadPhotoCheck(photo.id, check);
    }
    const logged = await this.reportRoad(name, cond, {
      kind: cond,
      where: where || caption || '',
      hash,
      photo_id: photo && photo.id,
      check_accurate: check ? check.accurate : undefined,
      check_seen: check && check.seen,
      check_nlu: check && check.nlu,
      photo_kind: check && check.kind
    });
    if (photo && photo.id && logged && logged.report_id) {
      await persist.linkRoadPhotoReport(photo.id, logged.report_id);
      photo.report_id = logged.report_id;
    }
    return {
      photo,
      check,
      logged,
      road: name,
      condition: cond,
      stored: !!(photo && photo.id),
      photo_id: photo && photo.id,
      report_id: logged && logged.report_id,
      neon: persist.enabled('road_photos')
    };
  },

  async roadPhotoHistory(hash) {
    return persist.loadRoadPhotoHistory(hash);
  },

  async setRoadKind({ photo_id, report_id, photo_kind, road } = {}) {
    if (photo_id && photo_kind) await persist.saveRoadPhotoKind(photo_id, photo_kind);
    if (report_id && photo_kind) await persist.saveRoadReportPlace(report_id, { photo_kind });
    const inc = (core.incidents || []).find(i =>
      (photo_id && i.photo_id === photo_id) || (report_id && i.report_id === report_id)
      || (road && String(i.road).toLowerCase() === String(road).toLowerCase()));
    if (inc && photo_kind) inc.photo_kind = photo_kind;
    return { photo_id, report_id, photo_kind };
  },

  async attachRoadWhere({ photo_id, report_id, lat, lng, where_text, contractor, photo_kind, road } = {}) {
    if (photo_id) {
      await persist.saveRoadPhotoPlace(photo_id, { lat, lng, where_text, contractor });
      if (photo_kind) await persist.saveRoadPhotoKind(photo_id, photo_kind);
    }
    if (report_id) await persist.saveRoadReportPlace(report_id, { lat, lng, where_text, contractor, photo_kind });
    const inc = (core.incidents || []).find(i =>
      (photo_id && i.photo_id === photo_id) || (report_id && i.report_id === report_id)
      || (road && String(i.road).toLowerCase() === String(road).toLowerCase()));
    if (inc) {
      if (where_text) inc.where = where_text;
      if (photo_kind) inc.photo_kind = photo_kind;
      if (contractor) inc.contractor = contractor;
      if (lat != null) inc.lat = lat;
      if (lng != null) inc.lng = lng;
    }
    return { photo_id, report_id, lat, lng, where_text };
  },

  async badRoads() {
    const neonRows = await persist.loadBadRoads();
    if (neonRows.length) {
      return neonRows.map(r => ({
        road: r.road,
        condition: r.condition,
        kind: r.photo_kind || r.kind,
        where: r.where_text || '',
        contractor: r.contractor || '',
        photo_id: r.photo_id,
        at: r.at
      }));
    }
    return (core.incidents || []).filter(i => {
      if (i.sample) return false;
      if (i.status === 'cleared' || i.kind === 'clear') return false;
      const k = i.photo_kind || 'road_condition';
      return k === 'road_condition' || k === 'accident';
    }).map(i => ({
      road: i.road,
      condition: i.kind || i.condition || 'blocked',
      kind: i.photo_kind || (i.kind === 'accident' ? 'accident' : 'road_condition'),
      where: i.where || '',
      contractor: i.contractor || '',
      photo_id: i.photo_id || null,
      at: i.reported_at
    }));
  },

  charts() { return core.charts; },
  survey() { return core.survey || { loaded: false, stations: (core.stations || []).length }; },
  core
};

function gazetteerFromCore() {
  const out = [];
  const seen = new Set();
  for (const s of core.stations || []) {
    if (!s.id || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push({ id: s.id, name: s.name, aliases: s.aliases || [] });
    for (const f of s.fares || []) {
      if (!f.to || seen.has(f.to)) continue;
      seen.add(f.to);
      out.push({ id: f.to, name: f.name, aliases: [] });
    }
  }
  return out;
}

let crowdReady = null;
function ready() {
  if (!crowdReady) {
    crowdReady = (async () => {
      await persist.overlayCrowd(core);
      rebuildPlaces();
      nlu.setGazetteer(gazetteerFromCore());
      await require('./countries').ready();
      await nlu.ready();
    })();
  }
  return crowdReady;
}

module.exports = { classify, classifyRegex, api, PLACES, nlu, ready, isRoadReport };
