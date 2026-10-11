/**
 * Hash table of the current fares and the other recorded rows.
 * OpenSearch finds a row. The number in the reply is this table's number.
 */
const core = require('../data/core.json');
const map = require('../data/ghana-stations.json');

const rows = new Map();
const searchIndex = new Map();
const BUCKET = 8;
const STOP = new Set([
  'the', 'and', 'for', 'you', 'your', 'how', 'much', 'what', 'where', 'when',
  'this', 'that', 'with', 'from', 'please', 'just', 'now', 'can', 'dey', 'be',
  'any', 'right', 'get', 'about', 'have', 'does', 'are'
]);

function put(row) {
  rows.set(row.id, row);
  return row;
}

function build() {
  for (const pin of map.stations || []) {
    if (!pin || !pin.id) continue;
    put({
      id: `place:${pin.id}`,
      kind: 'place',
      placeId: pin.id,
      name: pin.name || pin.id,
      region: pin.region || '',
      text: [pin.name, pin.region, pin.id].filter(Boolean).join(' ')
    });
  }
  for (const st of core.stations || []) {
    if (!st || !st.id) continue;
    put({
      id: `place:${st.id}`,
      kind: 'place',
      placeId: st.id,
      name: st.name,
      region: st.region || '',
      fareOrigin: true,
      text: [st.name, st.region, 'station', st.id].filter(Boolean).join(' ')
    });
    for (const fare of st.fares || []) {
      const amount = Number(fare.chart);
      if (!Number.isFinite(amount) || amount < 0 || fare.to === st.id) continue;
      put({
        id: `fare:${st.id}:${fare.to}`,
        kind: 'fare',
        fromId: st.id,
        toId: fare.to,
        fromName: st.name,
        toName: fare.name,
        fare: amount,
        estimated: fare.chart_status === 'estimate_pending_chart',
        status: fare.chart_status || '',
        text: `${st.name} ${fare.name} fare trotro ${st.id} ${fare.to}`
      });
    }
  }
  const window = (core.fuel && core.fuel.window) || {};
  put({
    id: 'fuel:window',
    kind: 'window',
    name: 'NPA window',
    window: window.window || '',
    petrol_floor: window.petrol_floor,
    diesel_floor: window.diesel_floor,
    text: `fuel window petrol diesel ${window.window || ''}`
  });
  for (const pump of (core.fuel && core.fuel.stations) || []) {
    put({
      id: `pump:${pump.id}`,
      kind: 'pump',
      pumpId: pump.id,
      name: pump.name,
      area: pump.area,
      petrol: pump.petrol,
      diesel: pump.diesel,
      text: `${pump.name} ${pump.area} petrol diesel fuel goil`
    });
  }
  const roads = new Set();
  for (const incident of core.incidents || []) {
    if (!incident || !incident.road || incident.sample) continue;
    const id = `road:${String(incident.road).toLowerCase()}`;
    if (roads.has(id)) continue;
    roads.add(id);
    put({
      id,
      kind: 'road',
      name: incident.road,
      text: `${incident.road} road wahala traffic`
    });
  }
  for (const chart of core.charts || []) {
    put({
      id: `chart:${chart.id}`,
      kind: 'chart',
      chartId: chart.id,
      name: chart.authority || chart.id,
      authority: chart.authority,
      status: chart.status,
      effective_from: chart.effective_from || '',
      note: chart.note || '',
      text: `${chart.authority || ''} ${chart.note || ''} fare chart gprtu`
    });
  }
  for (const stop of Object.values(core.stops || {})) {
    if (!stop || !stop.id) continue;
    put({
      id: `stop:${stop.id}`,
      kind: 'stop',
      stopId: stop.id,
      name: stop.name || stop.id,
      text: `${stop.name || stop.id} stop`
    });
  }
}

build();
indexSearch();

function words(text) {
  return [...new Set(String(text || '')
    .toLowerCase()
    .replace(/\bfoil\b/g, 'goil')
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w)))];
}

function addKey(key, id) {
  let bucket = searchIndex.get(key);
  if (!bucket) {
    bucket = [];
    searchIndex.set(key, bucket);
  }
  if (bucket.length >= BUCKET || bucket.includes(id)) return;
  bucket.push(id);
}

function indexRow(row) {
  const tokens = words(row.text).slice(0, 6);
  const n = tokens.length;
  for (let mask = 1; mask < (1 << n); mask++) {
    const subset = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) subset.push(tokens[i]);
    if (subset.length > 3) continue;
    const key = subset.sort().join(' ');
    addKey(key, row.id);
    addKey(row.kind + '\0' + key, row.id);
  }
}

function indexSearch() {
  for (const row of rows.values()) indexRow(row);
}

function comboKeys(tokens) {
  const words = tokens.slice(0, 3);
  const n = words.length;
  const masks = [];
  for (let mask = 1; mask < (1 << n); mask++) masks.push(mask);
  masks.sort((a, b) => bitCount(b) - bitCount(a));
  return masks.map(mask => {
    const subset = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) subset.push(words[i]);
    return subset.sort().join(' ');
  });
}

function bitCount(n) {
  let c = 0;
  while (n) { c += n & 1; n >>= 1; }
  return c;
}

function hydrate(ids) {
  return ids.map(id => rows.get(id)).filter(Boolean).map(row => ({ ...row, source: 'hash', score: 1 }));
}

function lookup(query, kind) {
  const tokens = words(query);
  if (!tokens.length) return [];
  const want = kind === 'fuel' ? 'pump' : kind;
  const keys = comboKeys(tokens);
  if (want && want !== 'where' && want !== 'stops') {
    for (const key of keys) {
      const scoped = searchIndex.get(want + '\0' + key);
      if (scoped && scoped.length) return hydrate(scoped);
    }
  }
  for (const key of keys) {
    const plain = searchIndex.get(key);
    if (plain && plain.length) return hydrate(plain);
  }
  return [];
}

function get(id) {
  return rows.get(id) || null;
}

function fare(fromId, toId) {
  if (!fromId || !toId) return null;
  return rows.get(`fare:${fromId}:${toId}`) || null;
}

function pump(id) {
  return rows.get(`pump:${id}`) || null;
}

function all() {
  return [...rows.values()];
}

module.exports = { get, fare, pump, all, lookup, words };
