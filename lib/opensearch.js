/**
 * Search over the fare hash table.
 * The query is one hash lookup. It does not walk the rows.
 * A hit is an id. The fare or price is read back from the table.
 */
const { Client } = require('@opensearch-project/opensearch');
const table = require('./data-table');

const INDEX = process.env.OPENSEARCH_INDEX || 'ghfares';

let client = null;
let indexed = false;

function nodeUrl() {
  const url = process.env.OPENSEARCH_URL;
  return url ? String(url) : '';
}

function cluster() {
  const url = nodeUrl();
  if (!url) return null;
  if (!client) client = new Client({ node: url });
  return client;
}

function tokens(text) {
  return table.words(text);
}

function rank(query, kind) {
  return table.lookup(query, kind);
}

function existsBody(res) {
  if (res === true) return true;
  if (!res) return false;
  if (res.body === true || res.statusCode === 200) return true;
  return false;
}

async function syncIndex() {
  const node = cluster();
  if (!node) return { indexed: 0, mode: 'hash' };
  const exists = await node.indices.exists({ index: INDEX });
  if (!existsBody(exists)) {
    await node.indices.create({
      index: INDEX,
      body: {
        mappings: {
          properties: {
            kind: { type: 'keyword' },
            name: { type: 'text' },
            text: { type: 'text' }
          }
        }
      }
    });
  }
  const body = [];
  for (const doc of table.all()) {
    body.push({ index: { _index: INDEX, _id: doc.id } });
    body.push({ kind: doc.kind, name: doc.name || '', text: doc.text });
  }
  if (body.length) await node.bulk({ refresh: true, body });
  indexed = true;
  return { indexed: table.all().length, mode: 'opensearch' };
}

async function search(query, kind) {
  return rank(query, kind);
}

module.exports = { search, rank, syncIndex, tokens };
