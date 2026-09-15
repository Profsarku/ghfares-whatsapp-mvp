/**
 * Country entry catalog.
 *
 * One Neon `countries` database lists every country we know. Ghana's
 * transport index lives in `survey` (and the Ghana peer DBs). Lookups
 * only run against the rider's chosen country — never another country's
 * rows. WhatsApp location sharing is the default way to pick the country.
 */
const persist = require('./db/persist');

const SEED = [
  { iso: 'gh', name: 'Ghana', aliases: ['ghana', 'gh', 'republic of ghana'], live: true, data_db: 'survey', bbox: [4.5, 11.2, -3.35, 1.25] },
  { iso: 'us', name: 'the United States', aliases: ['usa', 'us', 'united states', 'america', 'united states of america', 'u s a'], live: false, data_db: null, bbox: [24.4, 49.5, -125.0, -66.9] },
  { iso: 'ng', name: 'Nigeria', aliases: ['nigeria', 'ng', 'naija'], live: false, data_db: null, bbox: [4.2, 13.9, 2.6, 14.7] },
  { iso: 'gb', name: 'the United Kingdom', aliases: ['uk', 'gb', 'united kingdom', 'britain', 'great britain', 'england'], live: false, data_db: null, bbox: [49.8, 58.8, -8.2, 1.8] },
  { iso: 'ke', name: 'Kenya', aliases: ['kenya', 'ke'], live: false, data_db: null, bbox: [-4.8, 5.1, 33.9, 42.0] },
  { iso: 'za', name: 'South Africa', aliases: ['south africa', 'za', 'rsa'], live: false, data_db: null, bbox: [-35.0, -22.1, 16.4, 33.0] },
  { iso: 'ci', name: "Côte d'Ivoire", aliases: ['ivory coast', 'cote divoire', "cote d'ivoire", 'ci'], live: false, data_db: null, bbox: [4.3, 10.8, -8.7, -2.5] },
  { iso: 'tg', name: 'Togo', aliases: ['togo', 'tg'], live: false, data_db: null, bbox: [6.0, 11.2, -0.2, 1.8] },
  { iso: 'bf', name: 'Burkina Faso', aliases: ['burkina faso', 'burkina', 'bf'], live: false, data_db: null, bbox: [9.4, 15.1, -5.6, 2.5] }
];

let rows = SEED.slice();
let readyOnce = null;

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function list() {
  return rows;
}

function get(iso) {
  const k = String(iso || '').toLowerCase();
  return rows.find(c => c.iso === k) || null;
}

function isLive(iso) {
  const c = get(iso);
  return !!(c && c.live && c.data_db);
}

function dataDb(iso) {
  const c = get(iso);
  return (c && c.live && c.data_db) || null;
}

function inBbox(lat, lng, bbox) {
  if (!bbox || bbox.length !== 4) return false;
  const [latMin, latMax, lngMin, lngMax] = bbox;
  return lat >= latMin && lat <= latMax && lng >= lngMin && lng <= lngMax;
}

function fromCoords(lat, lng) {
  const a = Number(lat), b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return rows.find(c => inBbox(a, b, c.bbox)) || null;
}

function resolve(raw) {
  const t = norm(raw);
  if (!t) return null;
  const exact = rows.find(c => {
    const names = [c.iso, c.name, ...(c.aliases || [])].map(norm);
    return names.includes(t);
  });
  if (exact) return exact;
  let hit = null;
  let hitLen = 0;
  for (const c of rows) {
    const names = [c.name, ...(c.aliases || [])].map(norm).filter(n => n.length > 2);
    for (const n of names) {
      const re = new RegExp(`(?:^|\\s)${escapeRe(n)}(?:\\s|$)`);
      if (re.test(t) && n.length > hitLen) {
        hit = c;
        hitLen = n.length;
      }
    }
  }
  return hit;
}

function wantsSwitch(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (/^(change|switch) country\b/.test(t) || /^country\b/.test(t)) return true;
  if (/^(i('m| am) )?(now )?(in|from)\b/.test(t) && resolve(raw)) return true;
  return false;
}

function applySeed(list) {
  if (Array.isArray(list) && list.length) rows = list;
  else rows = SEED.slice();
}

async function ready() {
  if (readyOnce) return readyOnce;
  readyOnce = (async () => {
    await persist.seedCountries(SEED);
    const db = await persist.loadCountries();
    if (db && db.length) applySeed(db.map(r => ({
      iso: r.iso,
      name: r.name,
      aliases: r.aliases || [],
      live: !!r.live,
      data_db: r.data_db || null,
      bbox: [r.lat_min, r.lat_max, r.lng_min, r.lng_max]
    })));
  })();
  return readyOnce;
}

module.exports = {
  SEED, list, get, isLive, dataDb, fromCoords, resolve, wantsSwitch, ready, applySeed
};
