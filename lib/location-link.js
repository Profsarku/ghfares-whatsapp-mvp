/**
 * Short-lived links that let a phone browser send a GPS fix
 * back to the same WhatsApp or Messenger chat.
 *
 * The token is stored in the memory database so any server instance
 * can open the link. The process map is only a cache.
 */
const crypto = require('crypto');
const persist = require('./db/persist');

const TTL_MS = 2 * 60 * 60 * 1000;
const tokens = new Map();

function siteBase() {
  return String(process.env.SITE_URL || 'https://ghfares-whatsapp-mvp.vercel.app').replace(/\/$/, '');
}

function fresh(rec, now) {
  return !!(rec && now - rec.at <= TTL_MS);
}

function remember(rec) {
  tokens.set(rec.token, rec);
  return rec;
}

async function issue({ hash, from, channel }) {
  const now = Date.now();
  for (const [token, rec] of tokens) {
    if (!fresh(rec, now)) {
      tokens.delete(token);
      continue;
    }
    if (rec.hash === hash) {
      rec.from = from || rec.from;
      rec.channel = channel || rec.channel || 'whatsapp';
      rec.at = now;
      await persist.saveLocationLink(rec);
      return token;
    }
  }
  const stored = await persist.loadLocationLinkByHash(hash);
  if (fresh(stored, now)) {
    stored.from = from || stored.from;
    stored.channel = channel || stored.channel || 'whatsapp';
    stored.at = now;
    remember(stored);
    await persist.saveLocationLink(stored);
    return stored.token;
  }
  const token = crypto.randomBytes(16).toString('hex');
  const rec = { token, hash, from: from || hash, channel: channel || 'whatsapp', at: now };
  remember(rec);
  await persist.saveLocationLink(rec);
  return token;
}

async function read(token) {
  const key = String(token || '');
  const now = Date.now();
  const cached = tokens.get(key);
  if (cached) {
    if (!fresh(cached, now)) {
      tokens.delete(key);
      return null;
    }
    return cached;
  }
  const stored = await persist.loadLocationLink(key);
  if (!fresh(stored, now)) return null;
  return remember(stored);
}

function dropCache() {
  tokens.clear();
}

module.exports = { issue, read, dropCache, siteBase, TTL_MS };
