#!/usr/bin/env node
/**
 * Create one Postgres database per catalog name on a Neon project, then apply DDL.
 *
 *   DATABASE_URL=postgresql://…/neondb npm run db:setup
 *
 * Optional Neon API (creates missing databases without a superuser SQL session):
 *   NEON_API_KEY=… NEON_PROJECT_ID=… npm run db:setup
 */
const { Client } = require('pg');
const { CATALOG, NAMES } = require('../lib/db/catalog');
const schemas = require('../lib/db/schemas');
const { loadEnv, adminUrl, directUrl } = require('../lib/db/env');
const { urlFor } = require('../lib/db/neon');

const API = 'https://console.neon.tech/api/v2';

function quoteIdent(name) {
  if (!NAMES.includes(name)) throw new Error('unknown database: ' + name);
  return '"' + name.replace(/"/g, '""') + '"';
}

async function neonApi(path, { method = 'GET', body } = {}) {
  const key = process.env.NEON_API_KEY;
  if (!key) throw new Error('NEON_API_KEY missing');
  const r = await fetch(API + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + key,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = json.message || json.error || r.statusText;
    throw new Error('Neon API ' + path + ': ' + msg);
  }
  return json;
}

async function createViaApi() {
  let projectId = process.env.NEON_PROJECT_ID;
  if (!projectId) {
    const name = process.env.NEON_PROJECT_NAME || 'ghfares';
    const listed = await neonApi('/projects');
    const found = (listed.projects || []).find(p => p.name === name);
    if (found) projectId = found.id;
    else {
      console.log('Creating Neon project ' + name);
      const created = await neonApi('/projects', {
        method: 'POST',
        body: { project: { name, pg_version: 16 } }
      });
      projectId = created.project.id;
      const uri = created.connection_uris && created.connection_uris[0] && created.connection_uris[0].connection_uri;
      if (uri && !process.env.DATABASE_URL) process.env.DATABASE_URL = uri;
      console.log('Project ' + projectId);
    }
  }
  const project = await neonApi('/projects/' + projectId);
  const branchId = (project.project && project.project.default_branch_id)
    || (await neonApi('/projects/' + projectId + '/branches')).branches[0].id;
  const existing = await neonApi('/projects/' + projectId + '/branches/' + branchId + '/databases');
  const have = new Set((existing.databases || []).map(d => d.name));
  const owner = (existing.databases || []).find(d => d.owner_name)?.owner_name
    || process.env.NEON_OWNER || 'neondb_owner';
  for (const name of NAMES) {
    if (have.has(name)) {
      console.log('  exists  ' + name);
      continue;
    }
    await neonApi('/projects/' + projectId + '/branches/' + branchId + '/databases', {
      method: 'POST',
      body: { database: { name, owner_name: owner } }
    });
    console.log('  created ' + name);
  }
  return projectId;
}

function pgUrl(url) {
  const u = new URL(url);
  u.searchParams.delete('channel_binding');
  return u.toString();
}

function pgClient(url) {
  return new Client({
    connectionString: pgUrl(url),
    ssl: { rejectUnauthorized: true }
  });
}

async function createViaSql(base) {
  const admin = pgClient(directUrl(base));
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT datname FROM pg_database');
    const have = new Set(rows.map(r => r.datname));
    for (const name of NAMES) {
      if (have.has(name)) {
        console.log('  exists  ' + name);
        continue;
      }
      await admin.query('CREATE DATABASE ' + quoteIdent(name));
      console.log('  created ' + name);
    }
  } finally {
    await admin.end();
  }
}

async function applySchema(name) {
  const ddl = schemas[name];
  if (!ddl) throw new Error('no schema for ' + name);
  const url = directUrl(urlFor(name));
  const client = pgClient(url);
  await client.connect();
  try {
    await client.query(ddl);
    console.log('  schema  ' + name);
  } finally {
    await client.end();
  }
}

async function main() {
  loadEnv();
  const statusOnly = process.argv.includes('--status');
  const base = adminUrl();

  if (statusOnly) {
    if (!base) {
      console.log('Neon is not configured. Set DATABASE_URL to the default neondb connection string.');
      process.exit(1);
    }
    console.log('host  ' + new URL(base).host);
    console.log('databases');
    CATALOG.forEach(d => console.log('  ' + d.name + '  ' + d.holds));
    return;
  }

  if (!base && !process.env.NEON_API_KEY) {
    console.log(`GH Fares uses Neon: one project, a separate Postgres database per concern.

1. Open https://console.neon.tech and create a project named ghfares (Postgres 16).
2. Copy the connection string for the default database (neondb) into .env:

   DATABASE_URL=postgresql://USER:PASSWORD@ep-xxx.region.aws.neon.tech/neondb?sslmode=require

3. Run:  npm run db:setup

Or set NEON_API_KEY (and optionally NEON_PROJECT_ID) and re-run this script.
`);
    process.exit(1);
  }

  console.log('GH Fares  Neon setup  ' + NAMES.length + ' databases\n');
  if (process.env.NEON_API_KEY) {
    console.log('Creating databases via Neon API');
    await createViaApi();
  }
  if (!adminUrl()) {
    console.log('\nCreated the databases. Add DATABASE_URL to .env and run npm run db:setup again to apply schemas.');
    process.exit(1);
  }
  if (!process.env.NEON_API_KEY) {
    console.log('Creating databases via SQL on ' + new URL(directUrl(adminUrl())).host);
    await createViaSql(adminUrl());
  }
  console.log('\nApplying schemas');
  for (const name of NAMES) await applySchema(name);
  console.log('\nDone. Keep DATABASE_URL on Vercel (Production). The app rewrites the database name per concern.');
  console.log('Published charts still read from data/core.json until those reference databases are loaded.');
}

main().catch(e => {
  console.error(e.message || e);
  process.exit(1);
});
