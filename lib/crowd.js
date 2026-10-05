/**
 * Peer data that must not share a table with the chart.
 * names, verify, xp, fare_history, and signals are separate databases.
 * The process maps keep the same records when Neon is off (unit tests).
 */
const persist = require('./db/persist');

const nicknames = [];
const checks = new Map();
const scores = new Map();
const points = [];
const signals = [];
let hydrated = false;

function tierName(n) {
  if (n >= 20) return 'Station hand';
  if (n >= 8) return 'Regular';
  return 'Rider';
}

function norm(phrase) {
  return String(phrase || '').toLowerCase().replace(/[?!.]/g, '').replace(/\s+/g, ' ').trim();
}

async function ready() {
  if (hydrated) return;
  hydrated = true;
  for (const row of await persist.loadNicknames()) {
    nicknames.push({
      phrase: norm(row.phrase),
      stationId: row.station_id,
      hash: row.hash,
      status: row.status
    });
  }
  for (const row of await persist.loadChecks()) {
    checks.set(row.id, {
      id: row.id,
      kind: row.kind,
      stationId: row.station_id,
      routeKey: row.route_key,
      hash: row.hash,
      amount: row.amount != null ? Number(row.amount) : null,
      chart: row.chart != null ? Number(row.chart) : null,
      dest: row.dest,
      detail: row.detail || null,
      status: row.status,
      agrees: row.agrees || [],
      nays: row.nays || []
    });
  }
  for (const row of await persist.loadScores()) {
    scores.set(row.hash, { points: Number(row.points) || 0 });
  }
}

function resolveName(phrase) {
  const k = norm(phrase);
  const hit = nicknames.find(n => n.phrase === k && n.status === 'agreed');
  return hit ? hit.stationId : null;
}

function pendingName(phrase) {
  const k = norm(phrase);
  return nicknames.find(n => n.phrase === k && n.status === 'pending') || null;
}

async function rememberName(phrase, stationId, hash) {
  await ready();
  const k = norm(phrase);
  if (!k || !stationId) return null;
  const existing = nicknames.find(n => n.phrase === k && n.stationId === stationId);
  if (existing) {
    if (existing.status === 'pending' && existing.hash !== hash) return agreeName(k, stationId, hash);
    return existing;
  }
  const row = { phrase: k, stationId, hash, status: 'pending' };
  nicknames.push(row);
  await persist.saveNickname(row);
  return row;
}

async function agreeName(phrase, stationId, hash) {
  await ready();
  const k = norm(phrase);
  const row = nicknames.find(n => n.phrase === k && n.stationId === stationId && n.status === 'pending');
  if (!row || row.hash === hash) return row || null;
  row.status = 'agreed';
  await persist.saveNickname(row);
  await addPoints(row.hash, 2, 'nickname', stationId);
  return row;
}

function peersAt(stationId, hash) {
  const caps = require('./capabilities');
  const day = 24 * 60 * 60 * 1000;
  return [...caps.subscribers.values()].filter(s =>
    s.hash !== hash && s.station === stationId && s.reach && (Date.now() - (s.seen || 0)) < day
  );
}

async function openCheck(row) {
  await ready();
  const peers = peersAt(row.stationId, row.hash);
  const stored = {
    ...row,
    id: row.id || ('ck' + Math.random().toString(16).slice(2, 10)),
    status: 'pending',
    agrees: [],
    nays: []
  };
  checks.set(stored.id, stored);
  await persist.saveCheck(stored);
  if (peers.length) await addPoints(stored.hash, 1, 'filed', stored.id);
  return { id: stored.id, peers, lone: peers.length === 0 };
}

async function fileFare({ stationId, dest, amount, chart, hash, stationName, destName }) {
  return openCheck({
    kind: 'fare',
    stationId,
    routeKey: stationId + ':' + dest,
    hash,
    amount,
    chart,
    dest,
    destName,
    stationName
  });
}

async function fileReport({ kind, stationId, dest, hash, detail }) {
  return openCheck({
    kind,
    stationId,
    routeKey: stationId + ':' + (dest || detail || kind),
    hash,
    dest: dest || null,
    detail: detail || null
  });
}

async function vote(id, hash, yes) {
  await ready();
  const row = checks.get(id);
  if (!row || row.hash === hash || row.status !== 'pending') return row;
  if (yes) {
    if (!row.agrees.includes(hash)) row.agrees.push(hash);
  } else if (!row.nays.includes(hash)) row.nays.push(hash);
  if (row.agrees.length >= 2) {
    row.status = 'agreed';
    await addPoints(row.hash, 3, 'agreed', id);
    for (const peer of row.agrees) await addPoints(peer, 2, 'confirmed', id);
    if (row.kind === 'fare') {
      points.push({
        routeKey: row.routeKey,
        stationId: row.stationId,
        dest: row.dest,
        amount: row.amount,
        chart: row.chart,
        reportId: id,
        hash: row.hash,
        at: new Date().toISOString()
      });
      await persist.saveFarePoint(points[points.length - 1]);
    }
  } else if (row.nays.length >= 2) {
    row.status = 'contradicted';
  }
  await persist.saveCheck(row);
  return row;
}

async function addPoints(hash, delta, reason, reportId) {
  const row = scores.get(hash) || { points: 0 };
  row.points += delta;
  scores.set(hash, row);
  await persist.saveScore(hash, row.points, tierName(row.points));
  await persist.saveXpEvent(hash, delta, reason, reportId);
  return row;
}

function score(hash) {
  const row = scores.get(hash) || { points: 0 };
  return { points: row.points, tier: tierName(row.points) };
}

async function history(routeKey) {
  await ready();
  const local = points.filter(p => p.routeKey === routeKey);
  if (local.length) return local.slice();
  const rows = await persist.loadFarePoints(routeKey);
  return rows.map(r => ({
    routeKey: r.route_key,
    stationId: r.station_id,
    dest: r.dest,
    amount: Number(r.amount),
    chart: r.chart != null ? Number(r.chart) : null,
    reportId: r.report_id,
    hash: r.hash,
    at: r.at
  }));
}

async function signal(hash, voteName, replyKey) {
  const row = { hash, vote: voteName, replyKey: replyKey || null, at: new Date().toISOString() };
  signals.push(row);
  await persist.saveSignal(row);
  return row;
}

function review() {
  const tally = voteName => {
    const counts = new Map();
    for (const row of signals) {
      if (row.vote !== voteName || !row.replyKey) continue;
      const key = String(row.replyKey);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([name, n]) => ({ name, n }));
  };
  return {
    unknown: tally('unknown'),
    misses: tally('miss'),
    downvoted: tally('down'),
    taught: nicknames.filter(n => n.status === 'agreed').map(n => ({ phrase: n.phrase, stationId: n.stationId })),
    reported: points.filter(p => p.amount != null).slice(-20).map(p => ({ routeKey: p.routeKey, amount: p.amount }))
  };
}

function forget(hash) {
  for (let i = nicknames.length - 1; i >= 0; i--) if (nicknames[i].hash === hash) nicknames.splice(i, 1);
  for (const [id, row] of checks) if (row.hash === hash) checks.delete(id);
  scores.delete(hash);
  for (let i = points.length - 1; i >= 0; i--) if (points[i].hash === hash) points.splice(i, 1);
  for (let i = signals.length - 1; i >= 0; i--) if (signals[i].hash === hash) signals.splice(i, 1);
}

module.exports = {
  ready, resolveName, pendingName, rememberName, agreeName, peersAt,
  fileFare, fileReport, vote, score, history, signal, review, forget, tierName
};
