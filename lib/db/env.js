const fs = require('fs');
const path = require('path');

let loaded = false;

function loadEnv() {
  if (loaded) return;
  loaded = true;
  const file = path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

function firstEnv(...keys) {
  for (const key of keys) {
    const v = process.env[key];
    if (v) return v;
  }
  return '';
}

function adminUrl() {
  loadEnv();
  // Vercel Storage (Neon) injects DATABASE_URL; older Vercel Postgres used POSTGRES_URL.
  return firstEnv('NEON_DATABASE_URL', 'DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL');
}

/** Direct (non-pooler) URL for CREATE DATABASE and schema DDL. */
function directUrl(url) {
  loadEnv();
  const unpooled = firstEnv('DATABASE_URL_UNPOOLED', 'POSTGRES_URL_NON_POOLING');
  if (!url && unpooled) {
    const u = new URL(unpooled);
    u.searchParams.delete('channel_binding');
    return u.toString();
  }
  const raw = url || adminUrl();
  if (!raw) return '';
  const u = new URL(raw);
  u.host = u.host.replace(/-pooler\./, '.');
  u.searchParams.delete('channel_binding');
  return u.toString();
}

function configured() {
  return !!adminUrl();
}

module.exports = { loadEnv, adminUrl, directUrl, configured };
