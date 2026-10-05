/**
 * Fare subgraph. Places, stops, fuel, roads, charts, and add-ons live on
 * the platform graph. This walker only sums recorded fare edges.
 * A direct leg is reported. A path of real legs is composed. A per-kilometre
 * range is estimated only when no legs connect the two places.
 */
const core = require('../data/core.json');

const MAX_HOPS = 3;

function haversineKm(a, b) {
  const R = 6371;
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLng = (b.lng - a.lng) * r;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function build() {
  const nodes = new Map();
  const out = new Map();
  const direct = new Map();
  for (const st of core.stations || []) {
    nodes.set(st.id, { id: st.id, name: st.name, lat: st.lat, lng: st.lng });
  }
  for (const st of core.stations || []) {
    for (const f of st.fares || []) {
      const fare = Number(f.chart);
      if (!Number.isFinite(fare) || fare < 0) continue;
      if (f.to === st.id) continue;
      if (!nodes.has(f.to)) nodes.set(f.to, { id: f.to, name: f.name, lat: null, lng: null });
      const edge = {
        from: st.id,
        to: f.to,
        fromName: st.name,
        toName: f.name,
        fare,
        mode: f.mode || 'trotro',
        status: f.chart_status || '',
        estimated: f.chart_status === 'estimate_pending_chart'
      };
      const key = st.id + '>' + f.to;
      const prev = direct.get(key);
      if (prev && prev.fare <= edge.fare) continue;
      direct.set(key, edge);
    }
  }
  for (const edge of direct.values()) {
    if (!out.has(edge.from)) out.set(edge.from, []);
    out.get(edge.from).push(edge);
  }
  return { nodes, out, direct };
}

const graph = build();

function node(id) {
  return graph.nodes.get(id) || null;
}

function known(from, to) {
  return graph.direct.get(from + '>' + to) || null;
}

function planRoute(from, to) {
  if (!from || !to || from === to) return null;
  const direct = known(from, to);
  if (direct) {
    return {
      kind: direct.estimated ? 'estimated' : 'reported',
      legs: [direct],
      total: direct.fare
    };
  }
  const best = new Map([[from, 0]]);
  const pq = [{ node: from, cost: 0, hops: 0, path: [] }];
  while (pq.length) {
    pq.sort((a, b) => a.cost - b.cost || a.hops - b.hops);
    const cur = pq.shift();
    if (cur.cost !== best.get(cur.node)) continue;
    if (cur.node === to && cur.path.length >= 2) {
      return {
        kind: 'composed',
        legs: cur.path,
        total: cur.cost,
        anyEstimate: cur.path.some(e => e.estimated)
      };
    }
    if (cur.hops >= MAX_HOPS) continue;
    for (const edge of graph.out.get(cur.node) || []) {
      const next = cur.cost + edge.fare;
      const seen = best.get(edge.to);
      if (seen != null && seen <= next) continue;
      best.set(edge.to, next);
      pq.push({
        node: edge.to,
        cost: next,
        hops: cur.hops + 1,
        path: cur.path.concat(edge)
      });
    }
  }
  return estimate(from, to);
}

function rates() {
  const out = [];
  for (const edge of graph.direct.values()) {
    const a = node(edge.from);
    const b = node(edge.to);
    if (!a || !b || a.lat == null || b.lat == null) continue;
    const km = haversineKm(a, b);
    if (km < 0.4 || km > 40) continue;
    out.push(edge.fare / km);
  }
  out.sort((a, b) => a - b);
  return out;
}

function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - i) + sorted[hi] * (i - lo);
}

function moneyRound(n) {
  return Math.max(1, Math.round(n));
}

function estimate(from, to) {
  const a = node(from);
  const b = node(to);
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const km = haversineKm(a, b);
  if (km < 0.4 || km > 80) return null;
  const sample = rates();
  if (sample.length < 8) return null;
  const low = moneyRound(quantile(sample, 0.25) * km);
  const mid = moneyRound(quantile(sample, 0.5) * km);
  const high = moneyRound(quantile(sample, 0.75) * km);
  return {
    kind: 'estimated',
    legs: [],
    total: mid,
    low: Math.min(low, mid),
    high: Math.max(high, mid),
    km: Math.round(km * 10) / 10,
    samples: sample.length,
    fromName: a.name,
    toName: b.name
  };
}

module.exports = { planRoute, known, node, haversineKm };
