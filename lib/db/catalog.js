/**
 * One Neon project, one Postgres database per concern.
 * Shared ids only (hash, route_key, station_id). No cross-database SQL joins.
 */
const CATALOG = [
  { name: 'identity', group: 'platform', holds: 'legacy placeholder; live auth is the auth database' },
  { name: 'auth', group: 'platform', holds: 'WhatsApp hash: first seen is registration, later last_seen is auth. No password' },
  { name: 'users', group: 'platform', holds: 'add-ons, saved route, station, country, pending report' },
  { name: 'consent', group: 'platform', holds: 'append-only opt-in rows' },
  { name: 'sessions', group: 'platform', holds: 'welcomed_at, last intent, composer' },
  { name: 'index', group: 'platform', holds: 'search pointers only' },
  { name: 'messaging', group: 'platform', holds: 'inbound/outbound delivery receipts' },
  { name: 'places', group: 'reference', holds: 'stations, aliases, lat/lng' },
  { name: 'fares', group: 'reference', holds: 'published chart amounts' },
  { name: 'charts', group: 'reference', holds: 'authority, effective date, status' },
  { name: 'operators', group: 'reference', holds: 'VIP, STC, class names' },
  { name: 'stops', group: 'reference', holds: 'GTFS stop ids' },
  { name: 'fares_reports', group: 'peer', holds: 'rider amounts vs chart' },
  { name: 'roads', group: 'peer', holds: 'legacy placeholder; live reports are report_road_condition' },
  { name: 'report_road_condition', group: 'peer', holds: 'rider road reports and AI accuracy checks. Photo bytes live in road_photos, linked by hash and photo_id' },
  { name: 'road_photos', group: 'peer', holds: 'WhatsApp road-condition images plus per-user history. Linked to users.hash and report photo_id. No cross-DB SQL joins' },
  { name: 'fuel', group: 'peer', holds: 'NPA window and pump confirms' },
  { name: 'queues', group: 'peer', holds: 'bay loading pings' },
  { name: 'incidents', group: 'peer', holds: 'crash with a clock' },
  { name: 'broadcasts', group: 'channel', holds: 'template sends, frequency caps' },
  { name: 'entry', group: 'channel', holds: 'landing / QR beacons' },
  { name: 'partners', group: 'channel', holds: 'GPRTU/MTTD digest receipts' },
  { name: 'ai', group: 'model', holds: 'open-source Codex (gpt-oss): few-shots, endpoint, classify calls. API keys stay in env' },
  { name: 'countries', group: 'reference', holds: 'Country entry catalog: iso, aliases, live flag, which country data DB to query. No cross-DB joins' },
  { name: 'survey', group: 'reference', holds: 'Ghana (gh) transport index: Accra TroTro Apps Challenge 2015 stations, rebased fares, GTFS stops. Not an approved chart' }
];

const NAMES = CATALOG.map(d => d.name);
const byName = Object.fromEntries(CATALOG.map(d => [d.name, d]));

function assertName(name) {
  if (!byName[name]) throw new Error('unknown database: ' + name);
  return name;
}

module.exports = { CATALOG, NAMES, byName, assertName };
