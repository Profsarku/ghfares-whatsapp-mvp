const crypto = require('crypto');
const neon = require('./db/neon');
const caps = require('./capabilities');
const apiMod = require('./api');
const { api } = apiMod;

const COOKIE = 'ghfares_web';
const memory = new Map(); // nameKey -> account

function secret() {
  return process.env.SESSION_SECRET || process.env.APP_SECRET || 'ghfares-dev-session';
}

function nameKey(first, last) {
  return String(first || '').trim().toLowerCase() + '|' + String(last || '').trim().toLowerCase();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, 'hex');
  const got = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), want.length);
  return crypto.timingSafeEqual(want, got);
}

function signId(id) {
  const mac = crypto.createHmac('sha256', secret()).update(id).digest('hex');
  return id + '.' + mac;
}

function readSigned(value) {
  const raw = String(value || '');
  const dot = raw.indexOf('.');
  if (dot < 1) return null;
  const id = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const want = crypto.createHmac('sha256', secret()).update(id).digest('hex');
  const a = Buffer.from(mac);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return id;
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieHeader(id) {
  const secure = process.env.NODE_ENV === 'production' || process.env.DRY_RUN === 'false';
  return COOKIE + '=' + encodeURIComponent(signId(id))
    + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000'
    + (secure ? '; Secure' : '');
}

function clearCookieHeader() {
  return COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

async function applyPrefs(account) {
  await apiMod.ready();
  const s = caps.subscriber(account.hash);
  const firstStation = (account.stations_often || [])[0];
  if (firstStation) {
    const st = api.station(firstStation)
      || api.core.stations.find(x => x.name.toLowerCase() === String(firstStation).toLowerCase());
    if (st) s.station = st.id;
  }
  const parts = String(account.popular_route || '').split(/\s+to\s+/i);
  if (parts.length >= 2) {
    const f = api.fare(parts[0].trim(), parts[1].trim());
    if (f && f.kind === 'leg') {
      s.route = { from: f.from.id, to: f.to.to, fromName: f.from.name, toName: f.to.name, chart: f.to.chart };
    } else {
      s.route = { fromName: parts[0].trim(), toName: parts[1].trim() };
    }
  }
  caps.flush(account.hash, 'web').catch(e => console.error('neon user prefs', e.message || e));
}

function publicAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    first_name: row.first_name,
    last_name: row.last_name,
    stations_often: row.stations_often || [],
    popular_route: row.popular_route || ''
  };
}

function fromRow(row) {
  return {
    id: row.id || row.hash,
    hash: row.hash,
    first_name: row.first_name,
    last_name: row.last_name,
    password_hash: row.password_hash,
    stations_often: row.stations_often || [],
    popular_route: row.popular_route || '',
    channel: row.channel
  };
}

async function findByName(first, last) {
  const key = nameKey(first, last);
  if (!key || key === '|') return null;
  if (memory.has(key)) return memory.get(key);
  if (!neon.enabled('auth')) return null;
  try {
    const rows = await neon.sql('auth')`
      SELECT hash, id, first_name, last_name, password_hash, stations_often, popular_route, channel
      FROM accounts
      WHERE lower(first_name) = ${String(first).trim().toLowerCase()}
        AND lower(last_name) = ${String(last).trim().toLowerCase()}
      LIMIT 1
    `;
    return rows[0] ? fromRow(rows[0]) : null;
  } catch (e) {
    console.error('neon find auth', e.message || e);
    return null;
  }
}

async function findById(id) {
  if (!id) return null;
  for (const row of memory.values()) if (row.id === id) return row;
  if (!neon.enabled('auth')) return null;
  try {
    const rows = await neon.sql('auth')`
      SELECT hash, id, first_name, last_name, password_hash, stations_often, popular_route, channel
      FROM accounts WHERE id = ${id} OR hash = ${id} LIMIT 1
    `;
    return rows[0] ? fromRow(rows[0]) : null;
  } catch (e) {
    console.error('neon find auth id', e.message || e);
    return null;
  }
}

function normalizeStations(value) {
  if (Array.isArray(value)) return value.map(s => String(s).trim()).filter(Boolean);
  return String(value || '').split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
}

async function register({ first_name, last_name, password, stations_often, popular_route }) {
  const first = String(first_name || '').trim();
  const last = String(last_name || '').trim();
  const pass = String(password || '');
  if (!first || !last) return { error: 'first name and last name required', status: 400 };
  if (pass.length < 8) return { error: 'password must be at least 8 characters', status: 400 };
  const stations = normalizeStations(stations_often);
  const route = String(popular_route || '').trim();
  if (!stations.length) return { error: 'tell us the stations you travel from often', status: 400 };
  if (!route) return { error: 'tell us the route you use most', status: 400 };

  if (await findByName(first, last)) return { error: 'an account with that name already exists — sign in', status: 409 };

  const id = crypto.randomBytes(8).toString('hex');
  const hash = crypto.createHash('sha256').update('ghfares:web:' + id).digest('hex').slice(0, 16);
  const account = {
    id,
    hash,
    first_name: first,
    last_name: last,
    password_hash: hashPassword(pass),
    stations_often: stations,
    popular_route: route,
    channel: 'web'
  };
  memory.set(nameKey(first, last), account);

  if (neon.enabled('auth')) {
    try {
      await neon.sql('auth')`
        INSERT INTO accounts (hash, id, first_name, last_name, password_hash, stations_often, popular_route, channel, last_seen)
        VALUES (${hash}, ${id}, ${first}, ${last}, ${account.password_hash}, ${stations}, ${route}, 'web', now())
      `;
    } catch (e) {
      memory.delete(nameKey(first, last));
      if (/unique|duplicate/i.test(String(e.message))) {
        return { error: 'an account with that name already exists — sign in', status: 409 };
      }
      console.error('neon register', e.message || e);
      return { error: 'could not save the account', status: 503 };
    }
  }

  await applyPrefs(account);
  return { account: publicAccount(account) };
}

async function login({ first_name, last_name, password }) {
  const row = await findByName(first_name, last_name);
  if (!row || !row.password_hash || !verifyPassword(password, row.password_hash)) {
    return { error: 'name or password is wrong', status: 401 };
  }
  await applyPrefs(row);
  return { account: publicAccount(row) };
}

async function accountFromRequest(req) {
  const id = readSigned(parseCookies(req)[COOKIE]);
  if (!id) return null;
  return publicAccount(await findById(id));
}

module.exports = {
  COOKIE,
  cookieHeader,
  clearCookieHeader,
  accountFromRequest,
  register,
  login,
  publicAccount
};
