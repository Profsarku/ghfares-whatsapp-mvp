/**
 * In-process tests for JSON body handling, landing beacon, and Messenger profile.
 * Does not call Meta. Run: node test/json-body.js
 */
process.env.DRY_RUN = 'true';
delete process.env.FB_PAGE_TOKEN;

const http = require('http');
const app = require('../server');
const fb = require('../lib/messenger');

const fail = [];
const ok = [];
function pass(name, extra) { ok.push(name); console.log('  ok  ' + name + (extra ? '  ' + extra : '')); }
function bad(name, err) { fail.push(name); console.log('  FAIL  ' + name + '  ' + err); }

function listen(app) {
  return new Promise(resolve => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function req(server, path, opts = {}) {
  const { port } = server.address();
  const r = await fetch('http://127.0.0.1:' + port + path, opts);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, text };
}

(async () => {
  console.log('GH Fares unit tests  in-process\n');

  const profile = fb.messengerProfile();
  const chips = (profile.ice_breakers && profile.ice_breakers[0] && profile.ice_breakers[0].call_to_actions) || [];
  if (chips.length === 4 && chips.every(c => c.question && c.payload))
    pass('messengerProfile  4 ice breakers');
  else bad('messengerProfile ice_breakers', JSON.stringify(chips));
  if (profile.get_started && profile.get_started.payload === 'menu')
    pass('messengerProfile  get_started');
  else bad('messengerProfile get_started', JSON.stringify(profile.get_started));

  const server = await listen(app);

  const badJson = await req(server, '/v1/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{channel:fb}'
  });
  if (badJson.status === 400 && badJson.body && badJson.body.error === 'invalid json')
    pass('invalid JSON  returns 400, not 500');
  else bad('invalid JSON', badJson.status + ' ' + JSON.stringify(badJson.body));

  const empty = await req(server, '/v1/messenger-profile', { method: 'POST' });
  if (empty.status === 200 && empty.body && empty.body.data && empty.body.data.dry_run)
    pass('empty POST /v1/messenger-profile');
  else bad('empty POST messenger-profile', empty.status + ' ' + JSON.stringify(empty.body));

  const beacon = await req(server, '/v1/entry', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ channel: 'fb', source: 'unit' })
  });
  if (beacon.status === 204) pass('POST /v1/entry  text/plain beacon');
  else bad('POST /v1/entry text/plain', beacon.status);

  const entryJson = await req(server, '/v1/entry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'wa', source: 'unit' })
  });
  if (entryJson.status === 204) pass('POST /v1/entry  application/json');
  else bad('POST /v1/entry json', entryJson.status);

  const hook = await req(server, '/v1/webhook/messenger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ object: 'page', entry: [] })
  });
  if (hook.status === 200) pass('POST /v1/webhook/messenger  valid empty page');
  else bad('POST webhook messenger', hook.status + ' ' + JSON.stringify(hook.body));

  const standby = await req(server, '/v1/webhook/messenger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'page',
      entry: [{
        id: 'PAGE',
        standby: [{ sender: { id: 'PSID-STANDBY' }, message: { text: 'hi' } }]
      }]
    })
  });
  if (standby.status === 200) pass('POST /v1/webhook/messenger  standby hi');
  else bad('POST webhook standby', standby.status);

  const verify = await req(server, '/v1/webhook/messenger?hub.mode=subscribe&hub.verify_token=ghfares-verify&hub.challenge=unit-challenge');
  if (verify.status === 200 && verify.text === 'unit-challenge')
    pass('GET /v1/webhook/messenger  verify handshake');
  else bad('GET webhook verify', verify.status + ' ' + verify.text);

  const status = await req(server, '/v1/messenger-status');
  if (status.status === 200 && status.body && status.body.data && status.body.data.dry_run)
    pass('GET /v1/messenger-status  dry run');
  else bad('GET messenger-status', status.status + ' ' + JSON.stringify(status.body));

  const want = await req(server, '/v1/messenger-profile');
  const wantChips = want.body && want.body.data && want.body.data.ice_breakers
    && want.body.data.ice_breakers[0] && want.body.data.ice_breakers[0].call_to_actions;
  if (want.status === 200 && wantChips && wantChips.length === 4)
    pass('GET /v1/messenger-profile  ice breakers');
  else bad('GET messenger-profile', want.status);

  const home = await req(server, '/');
  if (home.status === 200 && home.text.includes("type: 'text/plain'"))
    pass('GET /  beacon uses text/plain');
  else bad('GET / beacon type', 'landing missing text/plain sendBeacon');

  const privacy = await req(server, '/privacy');
  if (privacy.status === 200 && /Privacy Policy/i.test(privacy.text)
      && /DELETE MY DATA/i.test(privacy.text)
      && /what data we collect/i.test(privacy.text))
    pass('GET /privacy  Meta-ready policy');
  else bad('GET /privacy', privacy.status);

  const delPage = await req(server, '/data-deletion');
  if (delPage.status === 200 && /DELETE MY DATA/i.test(delPage.text))
    pass('GET /data-deletion');
  else bad('GET /data-deletion', delPage.status);

  const wiped = await req(server, '/v1/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: 'unit-delete', text: 'DELETE MY DATA' })
  });
  const wipeBody = wiped.body && wiped.body.data && wiped.body.data.replies
    && wiped.body.data.replies[0] && wiped.body.data.replies[0].body;
  if (wiped.status === 200 && /deleted/i.test(String(wipeBody)))
    pass('POST /v1/ask  DELETE MY DATA');
  else bad('DELETE MY DATA', String(wipeBody).slice(0, 120));

  server.close();
  console.log('\n' + ok.length + ' passed, ' + fail.length + ' failed');
  if (fail.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
