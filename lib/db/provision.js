/**
 * Create a catalog database and its tables on first use, from the running app.
 *
 * Vercel Storage gives the app one Neon connection (DATABASE_URL) whose role
 * may create databases. So instead of waiting for `npm run db:setup`, a store
 * calls ensure(name) before it reads or writes: the schema is applied once per
 * process (every statement is IF NOT EXISTS), and when the database itself is
 * missing it is created over the admin connection first.
 *
 * Failures are logged and remembered for a minute, so a role without
 * CREATEDB costs one log line per minute, not one per message.
 */
const neon = require('./neon');
const schemas = require('./schemas');
const { adminUrl, directUrl } = require('./env');
const { assertName } = require('./catalog');

const ready = new Map();
const RETRY_MS = 60 * 1000;

/** Split a schema into single statements — the HTTP driver runs one at a time. */
function statements(ddl) {
  return String(ddl || '')
    .split(/;\s*(?:\n|$)/)
    .map(s => s.trim())
    .filter(Boolean);
}

function missingDatabase(e) {
  return /database "[^"]+" does not exist|3D000/i.test(String((e && (e.code || '')) + ' ' + (e && e.message)));
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/* The admin connection: the default database Vercel Storage points at, without the pooler. */
function admin() {
  const url = directUrl(adminUrl());
  if (!url) throw new Error('no admin connection for provisioning');
  const { neon: connect } = require('@neondatabase/serverless');
  return connect(url);
}

/* Connections, swappable in tests. */
const connect = {
  admin,
  database: name => neon.sql(name)
};

async function applySchema(name) {
  const sql = connect.database(name);
  for (const text of statements(schemas[name])) await sql.query(text);
}

async function create(name) {
  try {
    await connect.admin().query('CREATE DATABASE ' + quoteIdent(name));
    console.log('neon created database', name);
  } catch (e) {
    /* Another instance created it first. */
    if (!/already exists|42P04/i.test(String((e && e.code) || '') + ' ' + (e && e.message))) throw e;
  }
}

/**
 * Make sure database `name` and its tables exist. Resolves true when ready,
 * false when Neon is off or provisioning failed (the caller carries on without it).
 */
function ensure(name) {
  assertName(name);
  if (!neon.enabled(name) || !schemas[name]) return Promise.resolve(false);
  const known = ready.get(name);
  if (known && (known.ok || Date.now() - known.at < RETRY_MS)) return known.promise;
  const promise = (async () => {
    try {
      try {
        await applySchema(name);
      } catch (e) {
        if (!missingDatabase(e)) throw e;
        await create(name);
        await applySchema(name);
      }
      ready.set(name, { ok: true, at: Date.now(), promise: Promise.resolve(true) });
      return true;
    } catch (e) {
      console.error('neon provision', name, e.message || e);
      ready.set(name, { ok: false, at: Date.now(), promise: Promise.resolve(false) });
      return false;
    }
  })();
  ready.set(name, { ok: false, at: Date.now(), promise });
  return promise;
}

/** Tests: forget what is known to exist. */
function reset() {
  ready.clear();
}

module.exports = { ensure, statements, reset, connect };
