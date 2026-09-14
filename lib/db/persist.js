const neon = require('./neon');

function persistable(hash) {
  return !!(hash && neon.enabled() && !/^(unit-|wa-preview|demo)/i.test(hash));
}

async function safe(label, fn) {
  try {
    return await fn();
  } catch (e) {
    console.error('neon', label, e.message || e);
    return null;
  }
}

async function loadUsers() {
  if (!neon.enabled('users')) return [];
  return (await safe('load users', () => neon.sql('users')`
    SELECT hash, caps, route, station, context, pending, seen FROM users
  `)) || [];
}

async function loadSessions() {
  if (!neon.enabled('sessions')) return [];
  return (await safe('load sessions', () => neon.sql('sessions')`
    SELECT hash, welcomed_at, last_intent, composer, onboarded FROM sessions
  `)) || [];
}

async function loadConsent() {
  if (!neon.enabled('consent')) return [];
  return (await safe('load consent', () => neon.sql('consent')`
    SELECT hash, capability, at, method, source FROM opt_ins ORDER BY at
  `)) || [];
}

async function loadSends() {
  if (!neon.enabled('broadcasts')) return [];
  const cutoff = new Date(Date.now() - 86400000).toISOString();
  return (await safe('load sends', () => neon.sql('broadcasts')`
    SELECT hash, template, at FROM sends WHERE at > ${cutoff}
  `)) || [];
}

async function loadGouging() {
  if (!neon.enabled('fares_reports')) return [];
  return (await safe('load gouging', () => neon.sql('fares_reports')`
    SELECT route_key, avg_reported, chart, pct, reports FROM aggregates
  `)) || [];
}

async function loadQueues() {
  if (!neon.enabled('queues')) return [];
  return (await safe('load queues', () => neon.sql('queues')`
    SELECT route_key, state, at, pings FROM latest
  `)) || [];
}

async function loadRoadConditions() {
  if (!neon.enabled('report_road_condition')) return [];
  return (await safe('load road conditions', () => neon.sql('report_road_condition')`
    SELECT road_key, road, condition, kind, where_text, delay, status, confirmations, reports, reported_at
    FROM latest
  `)) || [];
}

async function overlayCrowd(core) {
  if (!neon.enabled()) return;
  const gouging = await loadGouging();
  for (const row of gouging) {
    core.gouging[row.route_key] = {
      avg_reported: Number(row.avg_reported),
      chart: Number(row.chart),
      pct: Number(row.pct),
      reports: Number(row.reports)
    };
  }
  const queues = await loadQueues();
  for (const row of queues) {
    const at = row.at instanceof Date ? row.at.toISOString() : String(row.at);
    core.queues[row.route_key] = { state: row.state, at, pings: Number(row.pings) };
  }
  const roads = await loadRoadConditions();
  for (const row of roads) {
    const id = 'rrc:' + row.road_key;
    const reported_at = row.reported_at instanceof Date ? row.reported_at.toISOString() : String(row.reported_at);
    const payload = {
      id,
      road: row.road,
      kind: row.kind || row.condition,
      where: row.where_text || '',
      delay: row.delay || '',
      status: row.status,
      confirmations: Number(row.confirmations),
      reported_at,
      source: 'crowd'
    };
    const existing = core.incidents.find(i => i.id === id || String(i.road).toLowerCase() === String(row.road).toLowerCase());
    if (existing) Object.assign(existing, payload);
    else core.incidents.unshift(payload);
  }
}

async function saveUser(s) {
  if (!persistable(s && s.hash) || !neon.enabled('users')) return;
  const caps = [...(s.caps || [])];
  const seen = new Date(s.seen || Date.now()).toISOString();
  await safe('save user', () => neon.sql('users')`
    INSERT INTO users (hash, caps, route, station, context, pending, seen)
    VALUES (${s.hash}, ${caps}, ${s.route || null}, ${s.station || null},
            ${s.context || null}, ${s.pending || null}, ${seen})
    ON CONFLICT (hash) DO UPDATE SET
      caps = EXCLUDED.caps,
      route = EXCLUDED.route,
      station = EXCLUDED.station,
      context = EXCLUDED.context,
      pending = EXCLUDED.pending,
      seen = EXCLUDED.seen
  `);
}

async function saveIdentity(hash, channel) {
  if (!persistable(hash) || !neon.enabled('auth')) return;
  await safe('save auth', () => neon.sql('auth')`
    INSERT INTO accounts (hash, channel, last_seen)
    VALUES (${hash}, ${channel || null}, now())
    ON CONFLICT (hash) DO UPDATE SET
      last_seen = now(),
      channel = COALESCE(EXCLUDED.channel, accounts.channel)
  `);
}

async function saveSession(s) {
  if (!persistable(s && s.hash) || !neon.enabled('sessions')) return;
  const welcomed = s.welcomedAt ? new Date(s.welcomedAt).toISOString() : null;
  await safe('save session', () => neon.sql('sessions')`
    INSERT INTO sessions (hash, welcomed_at, last_intent, composer, onboarded, updated_at)
    VALUES (${s.hash}, ${welcomed}, ${s.lastIntent || null}, ${s.pending || null},
            ${!!s.onboarded}, now())
    ON CONFLICT (hash) DO UPDATE SET
      welcomed_at = EXCLUDED.welcomed_at,
      last_intent = EXCLUDED.last_intent,
      composer = EXCLUDED.composer,
      onboarded = EXCLUDED.onboarded,
      updated_at = now()
  `);
}

async function saveConsent(row) {
  if (!persistable(row && row.hash) || !neon.enabled('consent')) return;
  await safe('save consent', () => neon.sql('consent')`
    INSERT INTO opt_ins (hash, capability, at, method, source)
    VALUES (${row.hash}, ${row.capability}, ${row.at}, ${row.method || null}, ${row.source || null})
  `);
}

async function saveSend(row) {
  if (!persistable(row && row.hash) || !neon.enabled('broadcasts')) return;
  await safe('save send', () => neon.sql('broadcasts')`
    INSERT INTO sends (hash, template, at)
    VALUES (${row.hash}, ${row.template}, ${row.at})
  `);
}

async function saveFareReport({ route_key, station_id, dest, amount, chart, hash, aggregate }) {
  if (!neon.enabled('fares_reports')) return;
  await safe('save fare report', async () => {
    const q = neon.sql('fares_reports');
    await q`
      INSERT INTO reports (route_key, station_id, dest, amount, chart, hash)
      VALUES (${route_key}, ${station_id}, ${dest}, ${amount}, ${chart}, ${hash || null})
    `;
    await q`
      INSERT INTO aggregates (route_key, avg_reported, chart, pct, reports, updated_at)
      VALUES (${route_key}, ${aggregate.avg_reported}, ${aggregate.chart},
              ${aggregate.pct}, ${aggregate.reports}, now())
      ON CONFLICT (route_key) DO UPDATE SET
        avg_reported = EXCLUDED.avg_reported,
        chart = EXCLUDED.chart,
        pct = EXCLUDED.pct,
        reports = EXCLUDED.reports,
        updated_at = now()
    `;
  });
}

async function saveQueue({ route_key, station_id, dest, state, hash, pings, at }) {
  if (!neon.enabled('queues')) return;
  await safe('save queue', async () => {
    const q = neon.sql('queues');
    await q`
      INSERT INTO pings (route_key, station_id, dest, state, hash)
      VALUES (${route_key}, ${station_id}, ${dest}, ${state}, ${hash || null})
    `;
    await q`
      INSERT INTO latest (route_key, state, at, pings)
      VALUES (${route_key}, ${state}, ${at}, ${pings})
      ON CONFLICT (route_key) DO UPDATE SET
        state = EXCLUDED.state,
        at = EXCLUDED.at,
        pings = EXCLUDED.pings
    `;
  });
}

async function saveRoadCondition({ road, condition, kind, where_text, delay, hash, status, confirmations }) {
  if (!neon.enabled('report_road_condition')) return;
  const road_key = String(road || '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!road_key) return;
  const cond = String(condition || 'blocked');
  const st = status || (cond === 'clear' ? 'cleared' : 'live');
  await safe('save road condition', async () => {
    const q = neon.sql('report_road_condition');
    await q`
      INSERT INTO reports (road_key, road, condition, kind, where_text, delay, hash)
      VALUES (${road_key}, ${road}, ${cond}, ${kind || null}, ${where_text || null},
              ${delay || null}, ${hash || null})
    `;
    const prev = await q`SELECT reports, confirmations FROM latest WHERE road_key = ${road_key}`;
    const n = (prev[0] ? Number(prev[0].reports) : 0) + 1;
    const conf = confirmations != null
      ? Number(confirmations)
      : (prev[0] ? Number(prev[0].confirmations) : 0);
    await q`
      INSERT INTO latest (road_key, road, condition, kind, where_text, delay, status, confirmations, reports, reported_at)
      VALUES (${road_key}, ${road}, ${cond}, ${kind || cond}, ${where_text || null},
              ${delay || null}, ${st}, ${conf}, ${n}, now())
      ON CONFLICT (road_key) DO UPDATE SET
        road = EXCLUDED.road,
        condition = EXCLUDED.condition,
        kind = EXCLUDED.kind,
        where_text = EXCLUDED.where_text,
        delay = EXCLUDED.delay,
        status = EXCLUDED.status,
        confirmations = EXCLUDED.confirmations,
        reports = EXCLUDED.reports,
        reported_at = now()
    `;
  });
  return { road_key, road, condition: cond, status: st };
}

async function saveRoadPhoto({ road, condition, caption, mime, bytes, wa_media_id, hash }) {
  if (!neon.enabled('report_road_condition')) return null;
  if (hash && !persistable(hash)) return null;
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!buf.length || buf.length > 4 * 1024 * 1024) return null;
  const roadName = String(road || 'unspecified road').trim() || 'unspecified road';
  const road_key = roadName.toLowerCase().replace(/\s+/g, '-');
  const cond = String(condition || 'blocked');
  const type = String(mime || 'image/jpeg');
  if (!/^image\//i.test(type)) return null;
  const hex = buf.toString('hex');
  const row = await safe('save road photo', async () => {
    const q = neon.sql('report_road_condition');
    const inserted = await q`
      INSERT INTO photos (road_key, road, condition, caption, mime, bytes, wa_media_id, hash)
      VALUES (${road_key}, ${roadName}, ${cond}, ${caption || null}, ${type},
              decode(${hex}, 'hex'), ${wa_media_id || null}, ${hash || null})
      RETURNING id
    `;
    return { id: inserted[0] && inserted[0].id, bytes: buf.length, road_key, road: roadName };
  });
  return row;
}

async function forget(hash) {
  if (!persistable(hash)) return;
  await safe('forget', async () => {
    if (neon.enabled('users')) await neon.sql('users')`DELETE FROM users WHERE hash = ${hash}`;
    if (neon.enabled('auth')) await neon.sql('auth')`DELETE FROM accounts WHERE hash = ${hash}`;
    if (neon.enabled('identity')) await neon.sql('identity')`DELETE FROM identities WHERE hash = ${hash}`;
    if (neon.enabled('sessions')) await neon.sql('sessions')`DELETE FROM sessions WHERE hash = ${hash}`;
    if (neon.enabled('consent')) await neon.sql('consent')`DELETE FROM opt_ins WHERE hash = ${hash}`;
    if (neon.enabled('report_road_condition')) {
      await neon.sql('report_road_condition')`DELETE FROM photos WHERE hash = ${hash}`;
    }
  });
}

module.exports = {
  persistable,
  loadUsers,
  loadSessions,
  loadConsent,
  loadSends,
  loadGouging,
  loadQueues,
  loadRoadConditions,
  overlayCrowd,
  saveUser,
  saveIdentity,
  saveSession,
  saveConsent,
  saveSend,
  saveFareReport,
  saveQueue,
  saveRoadCondition,
  saveRoadPhoto,
  forget,
  status: neon.status,
  enabled: neon.enabled,
  ping: neon.ping
};
