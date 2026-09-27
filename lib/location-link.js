/**
 * Short-lived links that let a phone browser send a GPS fix
 * back to the same WhatsApp or Messenger chat.
 */
const crypto = require('crypto');

const TTL_MS = 2 * 60 * 60 * 1000;
const tokens = new Map();

function siteBase() {
  return String(process.env.SITE_URL || 'https://ghfares-whatsapp-mvp.vercel.app').replace(/\/$/, '');
}

function issue({ hash, from, channel }) {
  const now = Date.now();
  for (const [token, rec] of tokens) {
    if (now - rec.at > TTL_MS) {
      tokens.delete(token);
      continue;
    }
    if (rec.hash === hash) {
      rec.from = from || rec.from;
      rec.channel = channel || rec.channel || 'whatsapp';
      rec.at = now;
      return token;
    }
  }
  const token = crypto.randomBytes(16).toString('hex');
  tokens.set(token, { hash, from: from || hash, channel: channel || 'whatsapp', at: now });
  return token;
}

function read(token) {
  const rec = tokens.get(String(token || ''));
  if (!rec) return null;
  if (Date.now() - rec.at > TTL_MS) {
    tokens.delete(token);
    return null;
  }
  return rec;
}

module.exports = { issue, read, siteBase, TTL_MS };
