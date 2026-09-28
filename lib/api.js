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
  ashaiman: 'tema motorway', atomic: 'madina',
  nkrumah: 'circle', 'kwame nkrumah': 'circle',
  'military hospital': '37', abeka: 'lapaz', odokor: 'odorkor',
  'pig farm': 'pig-farm-station', 'tema station': 'accra'
};

let locationPins = [];

function usablePlaceKey(k) {
  if (!k || k.length < 4 || k.startsWith('osm:')) return false;
  if (/^(east|west|north|south|main|station|accra|ghana|bus|taxi|rank|stop|trotro|tro tro)$/.test(k)) return false;
  return true;
}

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
  for (const p of locationPins) {
    const keys = [p.name, ...(p.aliases || [])];
    for (const raw of keys) {
      const k = String(raw || '').toLowerCase().trim();
      if (!usablePlaceKey(k) || PLACES[k]) continue;
      PLACES[k] = p.id;
    }
  }
  Object.assign(PLACES, PLACE_OVERRIDES);
}

rebuildPlaces();

const VAGUE_PLACES = new Set([
  'barrier', 'town', 'station', 'junction', 'market', 'stop', 'last stop',
  'lorry park', 'park', 'rank', 'here', 'there'
]);

function isVaguePlace(phrase) {
  const k = String(phrase || '').toLowerCase().replace(/^(the|a|an)\s+/, '').trim();
  return VAGUE_PLACES.has(k);
}

function exactPlace(phrase) {
  const agreed = require('./crowd').resolveName(phrase);
  if (agreed) return agreed;
  const k = String(phrase || '').toLowerCase().replace(/[?!.]/g, '').trim();
  if (!k || isVaguePlace(k)) return null;
  if (PLACES[k]) return PLACES[k];
  const stripped = k.replace(/\b(barrier|town|station|junction|market|stop|park|rank)\b/g, '').replace(/\s+/g, ' ').trim();
  if (stripped && stripped !== k && !isVaguePlace(stripped) && PLACES[stripped]) return PLACES[stripped];
  return null;
}

function routeMention(raw) {
  const t = String(raw || '').toLowerCase().replace(/[?]/g, ' ').replace(/\s+/g, ' ').trim();
  const m = t.match(/\bfrom\s+(.+?)\s+to\s+(.+)$/) || t.match(/\b(.+?)\s+to\s+(.+)$/);
  if (!m) return null;
  const scrub = s => s
    .replace(/^(what is the|what's the|whats the|how much is the|how much|current fare|the fare|fare|price|cost)\s+/g, '')
    .replace(/\b(current|fare|please)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const fromText = scrub(m[1]);
  const toText = scrub(m[2]);
  if (!fromText || !toText || fromText.length > 80 || toText.length > 80) return null;
  return {
    fromText,
    toText,
    fromId: exactPlace(fromText),
    toId: exactPlace(toText)
  };
}

function openQuestion(raw) {
  const mentioned = routeMention(raw);
  if (!mentioned) return null;
  if (mentioned.fromId && mentioned.toId) return null;
  return mentioned;
}

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
  return /\b(fare|fate|paid|paying|charge|charged|how much|₵|cedi|trotro money)\b/.test(t);
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

function fuelStationFromText(text) {
  const t = String(text || '').toLowerCase().replace(/\bfoil\b/g, 'goil').replace(/[^\w\s]/g, ' ');
  const stations = (core.fuel && core.fuel.stations) || [];
  let best = null;
  let bestScore = 0;
  for (const st of stations) {
    const tokens = String(st.name || '').toLowerCase().split(/\s+/).filter(w => w && w !== 'oil');
    if (!tokens.length) continue;
    const hits = tokens.filter(tok => new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t));
    const score = hits.length / tokens.length;
    if (score > bestScore) { best = st; bestScore = score; }
  }
  if (!best || bestScore < 0.75) return null;
  const brand = String(best.name).toLowerCase().split(/\s+/)[0];
  const brandHit = brand.startsWith('total') ? /\btotal\b/.test(t) : new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t);
  return brandHit ? best : null;
}

function fuelInquiry(raw) {
  if (isAddonUtterance(raw)) return false;
  if (fuelStationFromText(raw)) return true;
  return /\b(fuel|petrol|diesel|pump|filling station|gas|goil|foil)\b/.test(String(raw || '').toLowerCase());
}

function bareFare(raw) {
  if (fuelInquiry(raw)) return false;
  const t = String(raw || '').toLowerCase();
  if (/\b(fare|fate|trotro|tro tro|trofare|dropping|kalabule)\b/.test(t)) return true;
  if (/\bwo bay jay sen\b/.test(t)) return true;
  if (/\b(how much be|how e be)\b/.test(t)) return true;
  if (/\bdey charge\b/.test(t)) return true;
  if (/\bmate\b/.test(t) && /\b(how much|charge|charging|overcharge)\b/.test(t)) return true;
  return /\bhow much\b/.test(t);
}

function mentionedPlace(raw, id) {
  const t = String(raw || '').toLowerCase();
  const target = String(id || '').toLowerCase();
  if (!target) return false;
  const keys = Object.keys(PLACES).filter(name => String(PLACES[name]).toLowerCase() === target);
  keys.push(target);
  return keys.some(name => name.length >= 2 && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t));
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
  const addM = t.match(/^add(?:\s+(.*))?$/);
  if (addM) { out.intent = 'addon_add'; out.arg = (addM[1] || '').trim(); return out; }
  if (/^(remove|stop|drop)\s+/.test(t)) { out.intent = 'addon_remove'; out.arg = t.replace(/^(remove|stop|drop)\s+/, ''); return out; }
  if (/^(my addons|addons|add ons|what.s added|my adds)$/.test(t)) { out.intent = 'addon_list'; return out; }

  if (/^(help|keywords|commands|what can you do)\b/.test(t)) out.intent = 'help';
  else if (/^(where|where am i|find my station|locate)\b/.test(t)) out.intent = 'where';
  else if (/^menu\b/.test(t) && t.length < 18) out.intent = 'menu';
  else if (/\b(hi|hello|start|hey|good morning|good evening)\b/.test(t) && t.length < 18) out.intent = 'greet';
  else if (/^(my (road )?photos|my (road )?reports|my history|photo history|my road history)$/.test(t)) out.intent = 'road_history';
  else if (/\b(accident|crash|collision)\b/.test(t) && out.past) out.intent = 'incident_history';
  else if (fuelInquiry(raw)) out.intent = 'fuel';
  else if (/\b(queue|loading|bay)\b/.test(t) && !isRoadReport(t)) out.intent = 'queue';
  else if (/\b(dey move|cars dey|line dey)\b/.test(t)) out.intent = 'queue';
  else if (isRoadReport(t) || /\b(traffic|road|jam|accident|crash|block|closed|congestion|issue|happening|pothole|highway|motorway|wahala)\b/.test(t)) {
    out.intent = 'road';
    out.reporting = isRoadReport(t);
  }
  else if (/\b(fare chart|gprtu chart|chart revision|approved chart|what chart)\b/.test(t)) out.intent = 'chart';
  else if (/\b(cheap\w*|lowest|least|best price)\b/.test(t)) out.intent = 'cheapest';
  else if (bareFare(raw) || /\b(cost|charge|price)\b/.test(t) || out.places.length >= 2) out.intent = 'fare';
  else if (out.places.length === 1) out.intent = 'station';

  return out;
}

function isAddonUtterance(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (/^add(?:\s+.*)?$/.test(t)) return true;
  if (/^(remove|stop|drop)\s+\S/.test(t)) return true;
  if (/^(my addons|addons|add ons|what.s added|my adds)$/.test(t)) return true;
  return nlu.looksLikeAddonControl(t);
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

function finishClassify(raw, out) {
  if (!fuelInquiry(raw)) return out;
  out.intent = 'fuel';
  const pump = fuelStationFromText(raw);
  if (pump) out.fuelId = pump.id;
  delete out.amount;
  return out;
}

async function classify(raw, opts = {}) {
  await ready();
  const out = classifyRegex(raw);
  if (isStructuredCommand(raw, out)) return finishClassify(raw, out);

  let hit = await nlu.infer(String(raw || ''), {
    places: out.places,
    scope: out.scope,
    compare: out.compare,
    past: out.past,
    memory: opts.memory || [],
    facts: opts.facts || []
  });
  if (hit && /^addon_/.test(hit.intent) && !isAddonUtterance(raw)) {
    hit = { ...hit, intent: hit.ask ? 'fuel' : (out.intent || '') };
    if (!hit.intent) hit = null;
  }
  if (hit && hit.intent === 'fuel' && bareFare(raw)) {
    hit = { ...hit, intent: 'fare', ask: '' };
  }
  if (hit && Array.isArray(hit.places)) {
    hit = { ...hit, places: hit.places.filter(p => mentionedPlace(raw, p)) };
  }
  if (hit && hit.intent) {
    out.intent = hit.intent;
    out.via = 'model';
    out.nlu = hit.nlu;
    if (hit.arg) out.arg = hit.arg;
    if (hit.ask) out.ask = hit.ask;
    if (hit.scope) out.scope = hit.scope;
    out.compare = !!(hit.compare || out.compare);
    out.past = !!(hit.past || out.past);
    out.places = mergePlaces(out.places, hit.places);
    if (out.intent === 'road') out.reporting = !!(out.reporting || isRoadReport(raw));
    return finishClassify(raw, out);
  }
  if (out.intent) return finishClassify(raw, out);
  return finishClassify(raw, heuristicIntent(out));
}

/* ─────────────── API surface ─────────────── */
const api = {
  /** GET /v1/stations/near */
  stationsNear(lat, lng) {
    const pool = locationPins.length ? locationPins : core.stations;
    let best = null, bd = Infinity;
    for (const s of pool) {
      if (s.lat == null || s.lng == null) continue;
      const d = Math.hypot(s.lat - lat, s.lng - lng) * 111320;
      if (d < bd) { bd = d; best = s; }
    }
    const station = best ? (api.station(best.id) || best) : null;
    return { station, metres: best ? Math.round(bd) : null, too_far: !best || bd > 25000, source: 'places', authority: 'Ghana station map' };
  },

  /** GET /v1/stations/{id} */
  station(id) {
    const k = String(id || '').toLowerCase();
    if (!k) return null;
    const mapped = PLACES[k];
    const surveyed = core.stations.find(s =>
      s.id === id || s.id === k || s.id === mapped
      || (s.aliases || []).some(a => String(a).toLowerCase() === k)
    );
    if (surveyed) return surveyed;
    const pin = locationPins.find(s =>
      s.id === id || s.id === k || s.id === mapped
      || String(s.name || '').toLowerCase() === k
    );
    if (!pin) return null;
    return { ...pin, fares: [], branches: [] };
  },

  /** Names a rider might mean: stations, fare destinations, and surveyed stops. */
  placeChoices(phrase) {
    const raw = String(phrase || '').toLowerCase().replace(/[?!.]/g, '').replace(/\s+/g, ' ').trim();
    if (!raw) return [];
    const tokens = raw
      .replace(/\b(the|a|an|station|stop|park|rank|lorry)\b/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2);
    if (!tokens.length) return [];
    const matches = (name) => {
      const n = String(name || '').toLowerCase();
      return tokens.every(t => n.includes(t));
    };
    const out = [];
    const seen = new Set();
    const add = (row) => {
      const key = String(row.name || '').toLowerCase();
      if (!key || seen.has(key) || !matches(row.name)) return;
      seen.add(key);
      out.push(row);
    };
    for (const s of core.stations || []) {
      const blob = [s.name, ...(s.aliases || [])].join(' ');
      if (matches(blob)) add({ id: s.id, name: s.name, kind: 'station', lat: s.lat, lng: s.lng });
    }
    for (const s of core.stations || []) {
      for (const f of s.fares || []) {
        if (f.name && matches(f.name)) add({ id: f.to, name: f.name, kind: 'station', lat: s.lat, lng: s.lng });
      }
    }
    for (const p of locationPins) {
      if (matches([p.name, ...(p.aliases || [])].join(' '))) {
        add({ id: p.id, name: p.name, kind: 'station', lat: p.lat, lng: p.lng });
      }
    }
    for (const s of Object.values(core.stops || {})) {
      if (s && s.name) add({ id: s.id, name: s.name, kind: 'stop', lat: s.lat, lng: s.lng });
    }
    out.sort((a, b) => {
      const rank = (name) => {
        const n = name.toLowerCase();
        if (n === raw) return 0;
        if (n.startsWith(raw)) return 1;
        return 2;
      };
      return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);
    });
    return out.slice(0, 9);
  },

  /**
   * Places whose names match a vague word (barrier, town), nearest to a pin.
   * One WhatsApp location is a point, so this is the nearest match, not a traced path.
   */
  nearestMatchingPlaces(lat, lng, phrase, maxMetres = 8000) {
    if (lat == null || lng == null) return [];
    const raw = String(phrase || '').toLowerCase().replace(/[?!.]/g, '').replace(/\s+/g, ' ').trim();
    const tokens = raw
      .replace(/\b(the|a|an|station|stop|park|rank|lorry)\b/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2);
    if (!tokens.length) return [];
    const matches = (name) => {
      const n = String(name || '').toLowerCase();
      return tokens.every(t => n.includes(t));
    };
    const bestByName = new Map();
    const consider = (row) => {
      if (!row || row.lat == null || row.lng == null || !matches(row.name)) return;
      const metres = Math.round(Math.hypot(row.lat - lat, row.lng - lng) * 111320);
      if (metres > maxMetres) return;
      const key = String(row.name).toLowerCase();
      const prev = bestByName.get(key);
      if (!prev || metres < prev.metres) bestByName.set(key, { ...row, metres });
    };
    for (const s of Object.values(core.stops || {})) {
      consider({ id: s.id, name: s.name, kind: 'stop', lat: s.lat, lng: s.lng });
    }
    for (const s of core.stations || []) {
      if (matches(s.name) || (s.aliases || []).some(a => matches(a))) {
        consider({ id: s.id, name: s.name, kind: 'station', lat: s.lat, lng: s.lng });
      }
    }
    return [...bestByName.values()].sort((a, b) => a.metres - b.metres).slice(0, 5);
  },

  /** Nearest surveyed station that actually has a fare table. */
  nearestFareStation(lat, lng) {
    if (lat == null || lng == null) return null;
    let best = null;
    let bd = Infinity;
    for (const s of core.stations || []) {
      if (s.lat == null || s.lng == null || !(s.fares || []).length) continue;
      const d = Math.hypot(s.lat - lat, s.lng - lng) * 111320;
      if (d < bd) { bd = d; best = s; }
    }
    if (!best || bd > 8000) return null;
    return { id: best.id, name: best.name, metres: Math.round(bd) };
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
      fares: (st.fares || []).map(f => ({
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
    const held = core.gouging[key] || { avg_reported: f.chart, chart: f.chart, pct: 0, reports: 0 };
    await persist.saveFareReport({
      route_key: key, station_id: stationId, dest, amount, chart: f.chart, hash,
      aggregate: held
    });
    const crowd = require('./crowd');
    const filed = await crowd.fileFare({
      stationId, dest, amount, chart: f.chart, hash,
      stationName: st.name, destName: f.name
    });
    return {
      logged: amount, chart: f.chart, station: st.name, dest: f.name,
      verified: false, lone: filed.lone, peers: filed.peers, reportId: filed.id,
      pct: 0, reports: 0, avg_reported: f.chart
    };
  },

  async fareHistory(fromId, toId) {
    const crowd = require('./crowd');
    const routeKey = String(fromId || '') + ':' + String(toId || '');
    const rows = await crowd.history(routeKey);
    const st = api.station(fromId);
    const fare = st && (st.fares || []).find(f => f.to === toId);
    return {
      route_key: routeKey,
      from: st && st.name,
      to: fare && fare.name,
      chart: fare ? fare.chart : null,
      points: rows.map(p => ({ amount: p.amount, at: p.at }))
    };
  },

  /** POST /v1/reports/queue */
  async reportQueue(stationId, dest, state, hash) {
    const crowd = require('./crowd');
    const filed = await crowd.fileReport({
      kind: 'queue', stationId, dest, hash, detail: state
    });
    const st = api.station(stationId);
    const fare = st && (st.fares || []).find(f => f.to === dest);
    return {
      state, verified: false, lone: filed.lone, peers: filed.peers, reportId: filed.id,
      station: st && st.name, dest: fare && fare.name
    };
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
  for (const s of locationPins.length ? locationPins : (core.stations || [])) {
    if (!s.id || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push({ id: s.id, name: s.name, aliases: (s.aliases || []).filter(a => a && !String(a).startsWith('osm:')) });
  }
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
      locationPins = await persist.loadMapStations();
      rebuildPlaces();
      nlu.setGazetteer(gazetteerFromCore());
      await require('./countries').ready();
      await nlu.ready();
      await require('./crowd').ready();
    })();
  }
  return crowdReady;
}

module.exports = { classify, classifyRegex, api, PLACES, nlu, ready, isRoadReport, isAddonUtterance, routeMention, openQuestion, exactPlace, isVaguePlace };
