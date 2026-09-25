#!/usr/bin/env node
/**
 * Merge Accra survey parks with OpenStreetMap stations in Ghana and
 * upsert them into the places database.
 *
 *   node scripts/_fetch-osm-stations.js
 *   npm run db:load-places
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const schemas = require('../lib/db/schemas');
const { loadEnv, directUrl } = require('../lib/db/env');
const { urlFor } = require('../lib/db/neon');

const DATA = path.join(__dirname, '..', 'data');

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
}

function metres(a, b) {
  const R = 6371000;
  const p1 = a.lat * Math.PI / 180;
  const p2 = b.lat * Math.PI / 180;
  const dphi = (b.lat - a.lat) * Math.PI / 180;
  const dl = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(dphi / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bare(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(station|terminal|lorry park|taxi rank|trotro|tro tro|bus)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function similar(a, b) {
  const na = bare(a);
  const nb = bare(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length > 4 && nb.length > 4 && (na.includes(nb) || nb.includes(na))) return true;
  return false;
}

function slug(name, osmId) {
  const base = String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return base || ('osm-' + osmId);
}

function coord(el) {
  if (el.lat != null && el.lon != null) return { lat: el.lat, lng: el.lon };
  if (el.center && el.center.lat != null) return { lat: el.center.lat, lng: el.center.lon };
  return null;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function pgClient(url) {
  const u = new URL(url);
  u.searchParams.delete('channel_binding');
  return new Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: true } });
}

function build() {
  const review = readJson('accra-station-stops.review.json');
  const osm = readJson('osm-ghana-stations.raw.json');
  const survey = (review.stations || []).map(s => ({
    id: s.id,
    name: s.name,
    aliases: s.aliases || [],
    lat: s.lat,
    lng: s.lng,
    region: 'Greater Accra',
    source: 'survey'
  }));
  const taken = new Set(survey.map(s => s.id));
  const added = [];
  let skipped = 0;
  for (const el of osm.elements || []) {
    const name = el.tags && el.tags.name;
    const at = coord(el);
    if (!name || !at) { skipped++; continue; }
    const near = survey.find(s => metres(s, at) < 250 && similar(s.name, name))
      || survey.find(s => metres(s, at) < 80)
      || added.find(s => metres(s, at) < 120 && similar(s.name, name));
    if (near) { skipped++; continue; }
    const osmId = (el.type || 'node') + '/' + el.id;
    let id = slug(name, el.id);
    if (taken.has(id)) id = id + '-' + el.id;
    taken.add(id);
    const region = (el.tags['addr:region'] || el.tags['is_in:region'] || el.tags['addr:city'] || el.tags['is_in'] || '').trim() || null;
    added.push({
      id,
      name,
      aliases: ['osm:' + osmId],
      lat: at.lat,
      lng: at.lng,
      region,
      source: 'osm'
    });
  }
  const stations = survey.concat(added).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const doc = {
    purpose: 'Ghana station pins. Accra survey parks keep their station_id. Other pins are OpenStreetMap bus stations and public-transport stations.',
    counts: { survey: survey.length, osm: added.length, skipped, total: stations.length },
    stations
  };
  fs.writeFileSync(path.join(DATA, 'ghana-stations.json'), JSON.stringify(doc));
  return doc;
}

async function upsert(stations) {
  loadEnv();
  const url = directUrl(urlFor('places'));
  if (!url) throw new Error('DATABASE_URL missing');
  const client = pgClient(url);
  await client.connect();
  try {
    await client.query(schemas.places);
    await client.query(`DELETE FROM stations WHERE source = 'osm'`);
    for (const batch of chunk(stations, 80)) {
      const params = [];
      const values = batch.map(s => {
        const i = params.length;
        params.push(s.id, s.name, s.aliases, s.lat, s.lng, s.region, s.source);
        return `($${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5},$${i + 6},$${i + 7})`;
      });
      await client.query(
        `INSERT INTO stations (id, name, aliases, lat, lng, region, source)
         VALUES ${values.join(',')}
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           aliases = EXCLUDED.aliases,
           lat = EXCLUDED.lat,
           lng = EXCLUDED.lng,
           region = EXCLUDED.region,
           source = EXCLUDED.source`,
        params
      );
    }
    const { rows } = await client.query(
      `SELECT source, count(*)::int AS n FROM stations GROUP BY source ORDER BY source`
    );
    return rows;
  } finally {
    await client.end();
  }
}

async function main() {
  const doc = build();
  console.log('ghana stations', JSON.stringify(doc.counts));
  const outside = doc.stations.filter(s => s.lat > 6.2 || s.lng < -0.6 || s.lat < 5.4);
  console.log('pins outside the Accra survey box', outside.length);
  const rows = await upsert(doc.stations);
  console.log('places.stations', rows.map(r => r.source + '=' + r.n).join(' '));
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
