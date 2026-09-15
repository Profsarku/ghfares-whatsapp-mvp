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

async function overlaySurvey(core) {
  if (!neon.enabled('survey')) return;
  const stations = await safe('load survey stations', () => neon.sql('survey')`
    SELECT id, name, aliases, lat, lng, region, branch, branches FROM stations
  `);
  if (!stations || !stations.length) return;
  const meta = await safe('load survey meta', () => neon.sql('survey')`
    SELECT dataset, collected, note, rebase_factor, stations, routes, stops FROM meta WHERE id = 1
  `);
  const routes = await safe('load survey routes', () => neon.sql('survey')`
    SELECT route_key, station_id, dest, dest_name, fare_2015, fare_est, chart,
           chart_status, chart_id, route_id, stop_count, observations, mode, stops
    FROM routes
  `) || [];
  const charts = await safe('load survey charts', () => neon.sql('survey')`
    SELECT id, authority, effective_from, status, note, rebase_factor, covers FROM charts
  `);
  const byId = new Map(stations.map(s => [s.id, {
    id: s.id,
    name: s.name,
    aliases: s.aliases || [],
    lat: s.lat == null ? null : Number(s.lat),
    lng: s.lng == null ? null : Number(s.lng),
    region: s.region || undefined,
    branch: s.branch || undefined,
    branches: s.branches || [],
    fares: []
  }]));
  for (const prev of core.stations || []) {
    const row = byId.get(prev.id);
    if (!row) continue;
    const extra = (prev.aliases || []).filter(a => !row.aliases.includes(a));
    if (extra.length) row.aliases = row.aliases.concat(extra);
  }
  for (const r of routes) {
    const st = byId.get(r.station_id);
    if (!st) continue;
    st.fares.push({
      to: r.dest,
      name: r.dest_name,
      fare_2015: r.fare_2015 == null ? undefined : Number(r.fare_2015),
      fare_est: r.fare_est == null ? undefined : Number(r.fare_est),
      chart: Number(r.chart),
      chart_status: r.chart_status || undefined,
      route_id: r.route_id || undefined,
      stop_count: r.stop_count == null ? undefined : Number(r.stop_count),
      observations: r.observations == null ? undefined : Number(r.observations),
      mode: r.mode || 'trotro',
      chart_id: r.chart_id || undefined,
      bay: (r.dest_name || r.dest || 'bay') + ' bay',
      stops: r.stops || []
    });
  }
  for (const st of byId.values()) {
    st.fares.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  }
  const extras = (core.stations || []).filter(s => !byId.has(s.id));
  core.stations = [...byId.values(), ...extras];
  if (charts && charts.length) {
    core.charts = charts.map(c => ({
      id: c.id,
      authority: c.authority,
      effective_from: c.effective_from,
      status: c.status,
      note: c.note,
      rebase_factor: c.rebase_factor == null ? undefined : Number(c.rebase_factor),
      covers: c.covers || []
    }));
  }
  const m = meta && meta[0];
  core.survey = {
    loaded: true,
    dataset: m && m.dataset,
    collected: m && m.collected,
    note: m && m.note,
    rebase_factor: m && m.rebase_factor != null ? Number(m.rebase_factor) : 6.25,
    stations: stations.length,
    routes: routes.length
  };
  if (m && m.note) core.provenance = Object.assign({}, core.provenance, {
    fare_basis: 'surveyed_2015_rebased',
    warning: m.note,
    stations: stations.length,
    destinations: routes.length
  });
}

async function overlayCrowd(core) {
  if (!neon.enabled()) return;
  await overlaySurvey(core);
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

const AI_DEFAULTS = {
  model: 'openai/gpt-oss-20b',
  base_url: 'https://router.huggingface.co/v1',
  timeout_ms: 8000
};

async function seedAi(examples) {
  if (!neon.enabled('ai')) return;
  await safe('seed ai', async () => {
    const q = neon.sql('ai');
    await q`
      INSERT INTO settings (id, model, base_url, timeout_ms)
      VALUES (1, ${AI_DEFAULTS.model}, ${AI_DEFAULTS.base_url}, ${AI_DEFAULTS.timeout_ms})
      ON CONFLICT (id) DO NOTHING
    `;
    for (const ex of examples || []) {
      const places = Array.isArray(ex.places) ? ex.places : [];
      await q`
        INSERT INTO examples (text, intent, arg, places, scope, compare, past)
        VALUES (${ex.text}, ${ex.intent}, ${ex.arg || null}, ${places},
                ${ex.scope || null}, ${!!ex.compare}, ${!!ex.past})
        ON CONFLICT DO NOTHING
      `;
    }
  });
}

async function loadAiSettings() {
  if (!neon.enabled('ai')) return null;
  const rows = await safe('load ai settings', () => neon.sql('ai')`
    SELECT model, base_url, timeout_ms FROM settings WHERE id = 1
  `);
  return rows && rows[0] ? rows[0] : null;
}

async function loadAiExamples() {
  if (!neon.enabled('ai')) return [];
  const rows = await safe('load ai examples', () => neon.sql('ai')`
    SELECT text, intent, arg, places, scope, compare, past FROM examples ORDER BY id
  `);
  return (rows || []).map(r => ({
    text: r.text,
    intent: r.intent,
    arg: r.arg || undefined,
    places: r.places || [],
    scope: r.scope || undefined,
    compare: !!r.compare,
    past: !!r.past
  }));
}

async function saveAiCall({ text, intent, nlu, places, ms }) {
  if (!neon.enabled('ai')) return;
  const clipped = String(text || '').slice(0, 400);
  if (!clipped) return;
  const loc = Array.isArray(places) ? places : [];
  await safe('save ai call', () => neon.sql('ai')`
    INSERT INTO calls (text, intent, nlu, places, ms)
    VALUES (${clipped}, ${intent || null}, ${nlu || null}, ${loc}, ${ms || null})
  `);
}

async function loadSurveyGazetteer() {
  if (!neon.enabled('survey')) return [];
  const rows = await safe('load survey gazetteer', () => neon.sql('survey')`
    SELECT id, name, aliases FROM stations ORDER BY name
  `);
  return (rows || []).map(r => ({
    id: r.id,
    name: r.name,
    aliases: r.aliases || []
  }));
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
  overlaySurvey,
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
  seedAi,
  loadAiSettings,
  loadAiExamples,
  saveAiCall,
  loadSurveyGazetteer,
  status: neon.status,
  enabled: neon.enabled,
  ping: neon.ping
};
