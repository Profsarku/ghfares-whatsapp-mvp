/**
 * One graph for the platform. Fare edges are one relation.
 * Places, stops, pumps, roads, charts, and add-ons are nodes.
 * A tool walks this graph. It does not invent a fare or a price.
 */
const core = require('../data/core.json');
const map = require('../data/ghana-stations.json');
const { CAPABILITIES } = require('./capabilities');

const nodes = new Map();
const out = new Map();
const inn = new Map();
const fareKey = new Map();
const stopLegs = new Map();
const stopsByName = new Map();

function addNode(node) {
  const prev = nodes.get(node.id);
  nodes.set(node.id, prev ? { ...prev, ...node } : node);
  return nodes.get(node.id);
}

function link(from, to, rel, extra) {
  const edge = { from, to, rel, ...(extra || {}) };
  if (!out.has(from)) out.set(from, []);
  if (!inn.has(to)) inn.set(to, []);
  out.get(from).push(edge);
  inn.get(to).push(edge);
  return edge;
}

function place(row, extra) {
  const prev = nodes.get(row.id);
  return addNode({
    id: row.id,
    kind: 'place',
    name: row.name || (prev && prev.name) || row.id,
    lat: row.lat != null ? row.lat : (prev && prev.lat),
    lng: row.lng != null ? row.lng : (prev && prev.lng),
    region: row.region || (prev && prev.region) || null,
    source: row.source || (prev && prev.source) || null,
    fareOrigin: !!((prev && prev.fareOrigin) || (extra && extra.fareOrigin))
  });
}

function build() {
  for (const pin of map.stations || []) {
    if (pin && pin.id) place(pin);
  }
  for (const st of core.stations || []) {
    place(st, { fareOrigin: true });
  }
  for (const s of Object.values(core.stops || {})) {
    if (!s || !s.id) continue;
    addNode({
      id: `stop:${s.id}`,
      kind: 'stop',
      stopId: s.id,
      name: s.name || s.id,
      lat: s.lat,
      lng: s.lng
    });
    const name = String(s.name || '').toLowerCase();
    if (!name) continue;
    if (!stopsByName.has(name)) stopsByName.set(name, []);
    stopsByName.get(name).push(s.id);
  }

  for (const st of core.stations || []) {
    for (const fare of st.fares || []) {
      const amount = Number(fare.chart);
      if (!Number.isFinite(amount) || amount < 0 || fare.to === st.id) continue;
      if (!nodes.has(fare.to)) {
        place({ id: fare.to, name: fare.name });
      }
      const stops = (fare.stops || []).map(id => {
        const stop = core.stops && core.stops[id];
        return { id, name: (stop && stop.name) || id };
      });
      const edge = link(st.id, fare.to, 'fare', {
        fromName: st.name,
        toName: fare.name,
        fare: amount,
        estimated: fare.chart_status === 'estimate_pending_chart',
        status: fare.chart_status || '',
        stops
      });
      fareKey.set(`${st.id}>${fare.to}`, edge);
      for (const stop of stops) {
        if (!stopLegs.has(stop.id)) stopLegs.set(stop.id, []);
        stopLegs.get(stop.id).push(edge);
        link(`stop:${stop.id}`, st.id, 'along', { to: fare.to, order: stops.indexOf(stop) });
      }
    }
  }

  const window = (core.fuel && core.fuel.window) || {};
  addNode({
    id: 'fuel:window',
    kind: 'window',
    authority: window.authority || '',
    window: window.window || '',
    petrol_floor: window.petrol_floor,
    diesel_floor: window.diesel_floor
  });
  const areas = new Set();
  for (const pump of (core.fuel && core.fuel.stations) || []) {
    const id = `pump:${pump.id}`;
    addNode({
      id,
      kind: 'pump',
      pumpId: pump.id,
      name: pump.name,
      area: pump.area,
      petrol: pump.petrol,
      diesel: pump.diesel
    });
    link(id, 'fuel:window', 'priced_by');
    const areaId = `area:${String(pump.area || '').toLowerCase()}`;
    if (pump.area && !areas.has(areaId)) {
      areas.add(areaId);
      addNode({ id: areaId, kind: 'area', name: pump.area });
    }
    if (pump.area) link(id, areaId, 'in_area');
  }

  for (const incident of core.incidents || []) {
    const roadId = `road:${String(incident.road || '').toLowerCase()}`;
    addNode({ id: roadId, kind: 'road', name: incident.road });
    const incidentId = `incident:${incident.id}`;
    addNode({
      id: incidentId,
      kind: 'incident',
      incidentId: incident.id,
      name: incident.kind,
      road: incident.road,
      where: incident.where || '',
      delay: incident.delay || '',
      status: incident.status,
      sample: !!incident.sample,
      confirmations: incident.confirmations,
      source: incident.source,
      reported_at: incident.reported_at
    });
    link(roadId, incidentId, 'incident');
  }

  for (const chart of core.charts || []) {
    addNode({
      id: `chart:${chart.id}`,
      kind: 'chart',
      chartId: chart.id,
      authority: chart.authority,
      status: chart.status,
      effective_from: chart.effective_from || '',
      note: chart.note || ''
    });
  }

  const subjects = ['fare', 'fuel', 'road', 'queue', 'chart', 'addon', 'place', 'stops'];
  for (const id of subjects) addNode({ id: `subject:${id}`, kind: 'subject', name: id });

  for (const cap of CAPABILITIES) {
    addNode({
      id: `addon:${cap.id}`,
      kind: 'addon',
      addonId: cap.id,
      keyword: cap.keyword,
      name: cap.title,
      title: cap.title
    });
  }
  for (const node of nodes.values()) {
    if (node.kind === 'pump' || node.kind === 'area') link('addon:fuel', node.id, 'reads');
    if (node.kind === 'road') link('addon:roads', node.id, 'reads');
    if (node.kind === 'chart') link('addon:chart', node.id, 'reads');
    if (node.kind === 'place' && node.fareOrigin) {
      link('addon:queue', node.id, 'reads');
      link('addon:route', node.id, 'reads');
      link('addon:report', node.id, 'reads');
    }
    if (node.kind === 'place') link('addon:location', node.id, 'reads');
  }
}

build();

function ofKind(kind) {
  return [...nodes.values()].filter(n => n.kind === kind);
}

function outgoing(id, rel) {
  return (out.get(id) || []).filter(e => !rel || e.rel === rel);
}

function incoming(id, rel) {
  return (inn.get(id) || []).filter(e => !rel || e.rel === rel);
}

function around(id) {
  const node = nodes.get(id);
  if (!node || node.kind !== 'place') return null;
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    region: node.region || null,
    departures: outgoing(id, 'fare'),
    arrivals: incoming(id, 'fare')
  };
}

function stopsNamed(phrase) {
  const key = String(phrase || '').toLowerCase().trim();
  if (!key) return [];
  return (stopsByName.get(key) || []).map(stopId => ({
    stopId,
    name: (nodes.get(`stop:${stopId}`) || {}).name || stopId,
    legs: stopLegs.get(stopId) || []
  }));
}

function fareBetween(fromId, toId, toText) {
  const from = around(fromId);
  if (!from) return null;
  let edge = from.departures.find(e => e.to === toId);
  const said = String(toText || '').toLowerCase().trim();
  if (!edge && said) {
    edge = from.departures.find(e => String(e.toName || '').toLowerCase().includes(said));
  }
  if (!edge) return null;
  return {
    fromId: edge.from,
    toId: edge.to,
    fromName: edge.fromName,
    toName: edge.toName,
    names: (edge.stops || []).map(s => s.name)
  };
}

function pumpRow(node) {
  return { id: node.pumpId, name: node.name, area: node.area, petrol: node.petrol, diesel: node.diesel };
}

function pumpByText(text) {
  const t = String(text || '').toLowerCase().replace(/\bfoil\b/g, 'goil');
  let best = null;
  let bestScore = 0;
  for (const node of ofKind('pump')) {
    const tokens = String(node.name || '').toLowerCase().split(/\s+/).filter(w => w && w !== 'oil');
    if (!tokens.length) continue;
    const hits = tokens.filter(tok => t.includes(tok));
    const score = hits.length / tokens.length;
    if (score > bestScore) { best = node; bestScore = score; }
  }
  if (!best || bestScore < 0.75) return null;
  return pumpRow(best);
}

function pumps(area) {
  const want = area ? `area:${String(area).toLowerCase()}` : null;
  return ofKind('pump')
    .filter(node => !want || outgoing(node.id, 'in_area').some(e => e.to === want))
    .map(pumpRow)
    .sort((a, b) => a.petrol - b.petrol);
}

function fuelWindow() {
  return nodes.get('fuel:window') || null;
}

function incidents(road) {
  const said = String(road || '').toLowerCase();
  const roads = ofKind('road').filter(n => !said || String(n.name || '').toLowerCase().includes(said));
  const found = [];
  for (const roadNode of roads) {
    for (const edge of outgoing(roadNode.id, 'incident')) {
      const incident = nodes.get(edge.to);
      if (!incident || incident.sample || incident.status !== 'live') continue;
      found.push(incident);
    }
  }
  return found;
}

function charts() {
  return ofKind('chart');
}

function addons() {
  return ofKind('addon').map(node => ({
    id: node.addonId,
    keyword: node.keyword,
    title: node.title,
    reads: outgoing(node.id, 'reads').length
  }));
}

function addon(id) {
  const node = nodes.get(`addon:${id}`);
  if (!node) return null;
  return {
    id: node.addonId,
    keyword: node.keyword,
    title: node.title,
    reads: outgoing(node.id, 'reads').length
  };
}

function subject(name) {
  return nodes.get(`subject:${name}`) || null;
}

function counts() {
  const tally = {};
  for (const node of nodes.values()) tally[node.kind] = (tally[node.kind] || 0) + 1;
  tally.fare = [...fareKey.values()].length;
  tally.reads = [...out.values()].reduce((n, edges) => n + edges.filter(e => e.rel === 'reads').length, 0);
  return tally;
}

module.exports = {
  around,
  stopsNamed,
  fareBetween,
  pumpByText,
  pumps,
  fuelWindow,
  incidents,
  charts,
  addons,
  addon,
  subject,
  counts,
  outgoing
};
