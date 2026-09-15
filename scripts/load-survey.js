#!/usr/bin/env node
/**
 * Load the Accra TroTro Apps Challenge zip (fare-table-2015 + stops + charts)
 * into the `survey` database on the existing Neon project.
 *
 *   npm run db:setup
 *   npm run db:load-survey
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { loadEnv, adminUrl, directUrl } = require('../lib/db/env');
const { urlFor } = require('../lib/db/neon');

const REBASE = 6.25;
const CHART_ID = 'surveyed-2015-rebased';
const DATA = path.join(__dirname, '..', 'data');

function roundDenom(x) {
  if (x < 5) return Math.round(x * 2) / 2;
  if (x < 20) return Math.round(x);
  return Math.round(x / 5) * 5;
}

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function insertBatch(client, sql, rows, toParams) {
  for (const batch of chunk(rows, 80)) {
    const values = [];
    const params = [];
    let i = 1;
    const slots = toParams(batch[0]).length;
    for (const row of batch) {
      const parts = [];
      for (let k = 0; k < slots; k++) parts.push('$' + (i++));
      values.push('(' + parts.join(',') + ')');
      params.push(...toParams(row));
    }
    await client.query(sql.replace('__VALUES__', values.join(',')), params);
  }
}

function pgClient(url) {
  const u = new URL(url);
  u.searchParams.delete('channel_binding');
  return new Client({
    connectionString: u.toString(),
    ssl: { rejectUnauthorized: true }
  });
}

async function main() {
  loadEnv();
  if (!adminUrl()) {
    console.log('Set DATABASE_URL then run npm run db:setup and npm run db:load-survey');
    process.exit(1);
  }

  const table = readJson('fare-table-2015.json');
  const stops = readJson('stops-accra.json');
  const core = readJson('core.json');
  const aliasById = Object.fromEntries((core.stations || []).map(s => [s.id, s.aliases || []]));

  const stationRows = [];
  const routeRows = [];
  for (const s of Object.values(table.stations || {})) {
    const aliases = [...new Set([
      String(s.name || '').toLowerCase(),
      String(s.id || '').replace(/-/g, ' '),
      ...(aliasById[s.id] || [])
    ].filter(Boolean))];
    stationRows.push({
      id: s.id,
      name: s.name,
      aliases,
      lat: s.lat,
      lng: s.lng,
      region: 'Greater Accra',
      branch: (s.branches && s.branches[0]) || null,
      branches: s.branches || [],
      destination_count: s.destination_count || (s.destinations || []).length
    });
    for (const d of s.destinations || []) {
      const dest = d.to_slug || d.to;
      if (!dest) continue;
      const fare2015 = Number(d.fare_2015);
      const est = Number.isFinite(fare2015) ? roundDenom(fare2015 * REBASE) : null;
      routeRows.push({
        route_key: s.id + ':' + dest,
        station_id: s.id,
        dest,
        dest_name: d.to || dest,
        fare_2015: Number.isFinite(fare2015) ? fare2015 : null,
        fare_est: est,
        chart: est,
        chart_status: 'estimate_pending_chart',
        chart_id: CHART_ID,
        route_id: d.route_id || null,
        stop_count: d.stop_count || (d.stops || []).length,
        observations: d.observations || null,
        mode: 'trotro',
        stops: (d.stops || []).slice(0, 40)
      });
    }
  }

  const stopRows = Object.values(stops || {}).map(st => ({
    id: st.id,
    name: st.name || null,
    lat: st.lat,
    lng: st.lng,
    terminal: !!st.terminal
  }));

  const url = directUrl(urlFor('survey'));
  const client = pgClient(url);
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE meta, stations, routes, stops, charts');

    const src = table.source || {};
    await client.query(
      `INSERT INTO meta (id, dataset, collected, note, currency, rebase_factor, stations, routes, stops)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        src.dataset || 'Accra TroTro Apps Challenge',
        src.collected || null,
        src.note || null,
        src.currency || 'GHS',
        REBASE,
        stationRows.length,
        routeRows.length,
        stopRows.length
      ]
    );

    await insertBatch(client,
      `INSERT INTO stations (id, name, aliases, lat, lng, region, branch, branches, destination_count)
       VALUES __VALUES__`,
      stationRows,
      s => [s.id, s.name, s.aliases, s.lat, s.lng, s.region, s.branch, s.branches, s.destination_count]
    );
    await insertBatch(client,
      `INSERT INTO routes (route_key, station_id, dest, dest_name, fare_2015, fare_est, chart,
                           chart_status, chart_id, route_id, stop_count, observations, mode, stops)
       VALUES __VALUES__`,
      routeRows,
      r => [r.route_key, r.station_id, r.dest, r.dest_name, r.fare_2015, r.fare_est, r.chart,
            r.chart_status, r.chart_id, r.route_id, r.stop_count, r.observations, r.mode, r.stops]
    );
    await insertBatch(client,
      `INSERT INTO stops (id, name, lat, lng, terminal) VALUES __VALUES__`,
      stopRows,
      st => [st.id, st.name, st.lat, st.lng, st.terminal]
    );
    await insertBatch(client,
      `INSERT INTO charts (id, authority, effective_from, status, note, rebase_factor, covers)
       VALUES __VALUES__`,
      core.charts || [],
      c => [c.id, c.authority || null, c.effective_from || null, c.status || null,
            c.note || null, c.rebase_factor || null, c.covers || []]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }

  console.log('survey loaded');
  console.log('  stations  ' + stationRows.length);
  console.log('  routes    ' + routeRows.length);
  console.log('  stops     ' + stopRows.length);
  console.log('  charts    ' + (core.charts || []).length);
  console.log('Trotro amounts are 2015 surveyed fares rebased by ' + REBASE + ' — not an approved GPRTU chart.');
}

main().catch(e => {
  console.error(e.message || e);
  process.exit(1);
});
