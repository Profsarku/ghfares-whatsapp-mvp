/**
 * Pump price checks live in the fuel database, not in the chat
 * and not in verify. A request must name a station, a route, or a stop.
 * The index price is unchanged. A count is shown only after two other riders agree.
 */
const persist = require('./db/persist');

const requests = new Map();
let hydrated = false;

async function ready() {
  if (hydrated) return;
  hydrated = true;
  for (const row of await persist.loadFuelRequests()) {
    requests.set(row.id, fromDb(row));
  }
}

function fromDb(row) {
  return {
    id: row.id,
    pumpId: row.pump_id,
    stationId: row.station_id || null,
    routeKey: row.route_key || null,
    stopId: row.stop_id || null,
    petrol: row.petrol != null ? Number(row.petrol) : null,
    diesel: row.diesel != null ? Number(row.diesel) : null,
    hash: row.hash,
    status: row.status,
    agrees: row.agrees || [],
    nays: row.nays || []
  };
}

function sameLink(row, link) {
  return (row.stationId || null) === (link.stationId || null)
    && (row.routeKey || null) === (link.routeKey || null)
    && (row.stopId || null) === (link.stopId || null);
}

function agreed(pumpId) {
  for (const row of requests.values()) {
    if (row.pumpId === pumpId && row.status === 'agreed' && row.agrees.length >= 2) return row;
  }
  return null;
}

function peersFor(link, hash) {
  const caps = require('./capabilities');
  const day = 24 * 60 * 60 * 1000;
  return [...caps.subscribers.values()].filter(s => {
    if (!s || s.hash === hash || !s.reach) return false;
    if (Date.now() - (s.seen || 0) >= day) return false;
    if (link.stationId && s.station === link.stationId) return true;
    if (link.routeKey && s.route && s.route.from && s.route.to && (s.route.from + ':' + s.route.to) === link.routeKey) return true;
    if (link.stopId && s.context && s.context.stopId === link.stopId) return true;
    return false;
  });
}

async function open(pump, link, hash) {
  await ready();
  if (!link || (!link.stationId && !link.routeKey && !link.stopId)) return null;
  for (const row of requests.values()) {
    if (row.pumpId === pump.id && row.status !== 'contradicted' && sameLink(row, link)) {
      return { row, fresh: false, peers: [] };
    }
  }
  const row = {
    id: 'fc' + Math.random().toString(16).slice(2, 10),
    pumpId: pump.id,
    stationId: link.stationId || null,
    routeKey: link.routeKey || null,
    stopId: link.stopId || null,
    petrol: pump.petrol,
    diesel: pump.diesel,
    hash,
    status: 'pending',
    agrees: [],
    nays: []
  };
  requests.set(row.id, row);
  await persist.saveFuelRequest(row);
  return { row, fresh: true, peers: peersFor(link, hash) };
}

async function vote(id, hash, yes) {
  await ready();
  const row = requests.get(id);
  if (!row || row.status !== 'pending') return row || null;
  if (row.hash === hash) return row;
  if (yes) {
    if (!row.agrees.includes(hash)) row.agrees.push(hash);
  } else if (!row.nays.includes(hash)) row.nays.push(hash);
  if (row.agrees.length >= 2) row.status = 'agreed';
  else if (row.nays.length >= 2) row.status = 'contradicted';
  await persist.saveFuelRequest(row);
  return row;
}

function forget(hash) {
  for (const [id, row] of requests) {
    if (row.hash === hash) {
      requests.delete(id);
      continue;
    }
    row.agrees = (row.agrees || []).filter(h => h !== hash);
    row.nays = (row.nays || []).filter(h => h !== hash);
    if (row.status === 'agreed' && row.agrees.length < 2) row.status = 'pending';
  }
}

module.exports = { ready, open, vote, agreed, forget };
