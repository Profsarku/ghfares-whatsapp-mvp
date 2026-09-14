const { NAMES, assertName } = require('./catalog');
const { loadEnv, adminUrl, configured } = require('./env');

const clients = Object.create(null);

function urlFor(name) {
  loadEnv();
  assertName(name);
  const envKey = 'DATABASE_URL_' + name.toUpperCase();
  if (process.env[envKey]) return process.env[envKey];
  const base = adminUrl();
  if (!base) return '';
  const u = new URL(base);
  u.pathname = '/' + name;
  return u.toString();
}

function enabled(name) {
  if (!configured()) return false;
  if (name) return !!urlFor(name);
  return true;
}

function sql(name) {
  const url = urlFor(name);
  if (!url) throw new Error('DATABASE_URL missing for ' + name);
  if (!clients[name]) {
    const { neon } = require('@neondatabase/serverless');
    clients[name] = neon(url);
  }
  return clients[name];
}

function host() {
  const base = adminUrl();
  if (!base) return null;
  try { return new URL(base).host; } catch { return null; }
}

function status() {
  return {
    configured: configured(),
    host: host(),
    driver: configured() ? '@neondatabase/serverless' : null,
    databases: NAMES
  };
}

async function ping(name) {
  if (!enabled(name)) return { name, ok: false, reason: 'not configured' };
  try {
    await sql(name)`SELECT 1 AS ok`;
    return { name, ok: true };
  } catch (e) {
    return { name, ok: false, reason: e.message };
  }
}

module.exports = { urlFor, enabled, sql, host, status, ping, configured };
