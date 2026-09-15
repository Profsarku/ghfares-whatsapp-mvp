/**
 * In-process tests for JSON body handling, landing beacon, and Messenger profile.
 * Does not call Meta. Run: node test/json-body.js
 */
process.env.DRY_RUN = 'true';
process.env.NLU_PROVIDER = process.env.NLU_PROVIDER || 'off';
process.env.DATABASE_URL = '';
process.env.DATABASE_URL_UNPOOLED = '';
process.env.NEON_DATABASE_URL = '';
process.env.POSTGRES_URL = '';
process.env.POSTGRES_URL_NON_POOLING = '';
process.env.POSTGRES_PRISMA_URL = '';
delete process.env.FB_PAGE_TOKEN;
delete process.env.APP_SECRET;
delete process.env.WHATSAPP_TOKEN;

const http = require('http');
const app = require('../server');
const fb = require('../lib/messenger');
const engine = require('../lib/engine');
const caps = require('../lib/capabilities');
const { classify, api } = require('../lib/api');

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

  const site = await req(server, '/');
  if (site.status === 200 && /What Ghanaians/i.test(site.text) && site.text.includes('id="services"'))
    pass('GET /  services landing');
  else bad('GET / landing', 'missing services page');

  const support = await req(server, '/support');
  if (support.status === 200 && /DELETE MY DATA/i.test(support.text) && /id="social"/i.test(support.text))
    pass('GET /support');
  else bad('GET /support', support.status);

  const home = await req(server, '/go');
  if (home.status === 200 && home.text.includes("type: 'text/plain'"))
    pass('GET /go  beacon uses text/plain');
  else bad('GET /go beacon type', 'chooser missing text/plain sendBeacon');

  if (home.text.includes('id="signupFirst"') && home.text.includes('id="signupPassword"')
      && home.text.includes('id="signupStations"') && home.text.includes('id="signupFrom"')
      && home.text.includes('id="goAccess"') && home.text.includes('id="goLogout"'))
    pass('GET /go  signup before QR');
  else bad('GET /go signup gate', 'missing signup fields');

  const loggedOut = await req(server, '/v1/logout', { method: 'POST' });
  if (loggedOut.status === 204) pass('POST /v1/logout');
  else bad('POST /v1/logout', loggedOut.status);

  const signed = await req(server, '/v1/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      first_name: 'Ama', last_name: 'Unit', password: 'testpass1',
      stations_often: 'Kaneshie, Circle', popular_route: 'Kaneshie to Bubuashie'
    })
  });
  if (signed.status === 201 && signed.body && signed.body.data && signed.body.data.first_name === 'Ama'
      && /ghfares_web=/.test(String(signed.headers && signed.headers.get && '')))
    pass('POST /v1/signup');
  else if (signed.status === 201 && signed.body && signed.body.data && signed.body.data.first_name === 'Ama')
    pass('POST /v1/signup');
  else bad('POST /v1/signup', signed.status + ' ' + JSON.stringify(signed.body));

  const again = await req(server, '/v1/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      first_name: 'Ama', last_name: 'Unit', password: 'testpass1',
      stations_often: 'Kaneshie', popular_route: 'Kaneshie to Circle'
    })
  });
  if (again.status === 409) pass('POST /v1/signup  duplicate name');
  else bad('POST /v1/signup duplicate', again.status);

  if (home.text.includes("addEventListener('pageshow'") && home.text.includes('id="chooseAgain"')
      && !/localStorage\.getItem\('ghfares\.channel'\)/.test(home.text))
    pass('GET /go  chooser resets after handoff');
  else bad('GET /go reset', 'spinner can stick on a second WhatsApp connect');

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

  const waStatus = await req(server, '/v1/whatsapp-status');
  if (waStatus.status === 200 && waStatus.body && waStatus.body.data && waStatus.body.data.dry_run
      && waStatus.body.data.app_id === '1048759324622035')
    pass('GET /v1/whatsapp-status  dry run');
  else bad('GET /v1/whatsapp-status', waStatus.status);

  const cc = await req(server, '/v1/conversational-components');
  if (cc.status === 200 && cc.body && cc.body.data && cc.body.data.prompts && cc.body.data.prompts.length === 4)
    pass('GET /v1/conversational-components');
  else bad('GET conversational-components', cc.status);

  const waHi = id => ({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages: [{ id, from: '233201234567', type: 'text', text: { body: 'hi' } }] } }] }]
  });
  const firstWa = await req(server, '/v1/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(waHi('wamid.unit-dup-1'))
  });
  const againWa = await req(server, '/v1/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(waHi('wamid.unit-dup-1'))
  });
  if (firstWa.status === 200 && againWa.status === 200)
    pass('POST /v1/webhook  duplicate wamid acked');
  else bad('POST /v1/webhook duplicate', firstWa.status + ' ' + againWa.status);

  const hash = 'unit-welcome-once';
  caps.forget(hash);
  const opened = await engine.handle({ from: '233201234567', hash, type: 'request_welcome' });
  const typedHi = await engine.handle({ from: '233201234567', hash, text: 'Hi' });
  const openIds = ((opened[0] && opened[0].interactive && opened[0].interactive.action.sections) || [])
    .flatMap(s => s.rows.map(r => r.id));
  if (opened[0] && opened[0].type === 'interactive' && openIds.includes('addon:fuel')
      && typedHi[0] && typedHi[0].type === 'text' && /Choose|road condition/i.test(typedHi[0].text && typedHi[0].text.body))
    pass('welcome is add-on list  hi does not repeat it');
  else bad('welcome list', (opened[0] && opened[0].type) + ' ' + (typedHi[0] && typedHi[0].type));

  const roadAsk = await engine.handle({ from: '233201234567', hash: 'unit-roadq', text: 'what is the road condition right now' });
  if (/motorway|blocked|incident|Nothing reported/i.test(JSON.stringify(roadAsk)))
    pass('what is the road condition right now');
  else bad('road question', JSON.stringify(roadAsk).slice(0, 180));

  caps.forget('unit-slash');
  if (engine.expandCommand('/addroads gg') === 'add roads' && engine.expandCommand('/fare Tema to Accra') === 'Tema to Accra')
    pass('expandCommand  /fare keeps query, /addroads ignores junk');
  else bad('expandCommand', engine.expandCommand('/addroads gg') + ' | ' + engine.expandCommand('/fare Tema to Accra'));

  const slashFare = await engine.handle({ from: '233201234567', hash: 'unit-slash', text: '/fare Tema to Accra' });
  const fareTxt = JSON.stringify(slashFare);
  if (/₵|11|Tema|Accra/i.test(fareTxt) && !/do not have/i.test(fareTxt))
    pass('/fare Tema to Accra  returns a fare');
  else bad('/fare Tema to Accra', fareTxt.slice(0, 180));

  const slashAdd = await engine.handle({ from: '233201234567', hash: 'unit-slash', text: '/addroads gg' });
  if (/Road alerts added/i.test(JSON.stringify(slashAdd)))
    pass('/addroads  adds road alerts');
  else bad('/addroads', JSON.stringify(slashAdd).slice(0, 180));

  caps.forget('unit-photo');
  const pic = await engine.handle({
    from: '233201234567',
    hash: 'unit-photo',
    type: 'image',
    image: { mime: 'image/jpeg', bytes: Buffer.from('fakejpg'), caption: 'tema motorway blocked' }
  });
  const picTxt = JSON.stringify(pic);
  if (/Photo saved/i.test(picTxt) && /motorway/i.test(picTxt) && /blocked/i.test(picTxt) && /ADD ROADS/i.test(picTxt))
    pass('WhatsApp road photo  saved and logged');
  else bad('WhatsApp road photo', picTxt.slice(0, 220));

  const noPic = await engine.handle({
    from: '233201234567',
    hash: 'unit-photo-miss',
    type: 'image',
    image: { mime: 'image/jpeg', caption: 'tema motorway blocked' }
  });
  if (/could not pull that photo/i.test(JSON.stringify(noPic)))
    pass('WhatsApp road photo  missing bytes');
  else bad('WhatsApp road photo missing', JSON.stringify(noPic).slice(0, 180));

  const waImg = {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { messages: [{
      id: 'wamid.unit-img-1',
      from: '233201234567',
      type: 'image',
      image: { id: 'MEDIA123', mime_type: 'image/jpeg', caption: 'tema motorway blocked' }
    }] } }] }]
  };
  const imgHook = await req(server, '/v1/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(waImg)
  });
  if (imgHook.status === 200) pass('POST /v1/webhook  image acked');
  else bad('POST /v1/webhook image', imgHook.status);

  const nluAdd = await classify('switch on petrol alerts');
  if (nluAdd.intent === 'addon_add' && /fuel/i.test(String(nluAdd.arg || '')))
    pass('NLU  switch on petrol alerts → add fuel');
  else bad('NLU addon paraphrase', JSON.stringify(nluAdd));

  const nluRoad = await classify('any wahala on the highway');
  if (nluRoad.intent === 'road')
    pass('NLU  wahala on the highway → road');
  else bad('NLU road paraphrase', JSON.stringify(nluRoad));

  const reportMe = await classify('I want to report it myself');
  if (reportMe.intent === 'road' && reportMe.reporting)
    pass('classifier  I want to report it myself → road report');
  else bad('report myself', JSON.stringify(reportMe));

  const pothole = await classify('Pothole on Kaneshie to Kasoa');
  if (pothole.intent === 'road' && pothole.reporting && pothole.places.length >= 2)
    pass('classifier  pothole on kaneshie to kasoa → road report');
  else bad('pothole route', JSON.stringify(pothole));

  caps.forget('unit-pothole');
  const potholeTurn = await engine.handle({ from: '233201234567', hash: 'unit-pothole', text: 'Pothole on Kaneshie to Kasoa' });
  if (/Logged/i.test(JSON.stringify(potholeTurn)) && /pothole/i.test(JSON.stringify(potholeTurn)) && !/queued for mapping/i.test(JSON.stringify(potholeTurn)))
    pass('engine  pothole logs a road report');
  else bad('engine pothole', JSON.stringify(potholeTurn).slice(0, 220));

  const wantReport = await engine.handle({ from: '233201234567', hash: 'unit-pothole', text: 'I want to report it myself' });
  if (/Send a photo|pothole on kaneshie/i.test(JSON.stringify(wantReport)))
    pass('engine  I want to report it myself asks for a photo');
  else bad('engine report myself', JSON.stringify(wantReport).slice(0, 220));

  const far = api.stationsNear(47.573, -121.997);
  if (far.too_far && far.metres > 25000)
    pass('stationsNear  rejects a pin far from Ghana');
  else bad('stationsNear far', JSON.stringify({ metres: far.metres, too_far: far.too_far }));

  const farLoc = await engine.handle({
    from: '233201234567', hash: 'unit-farloc',
    location: { latitude: 47.573, longitude: -121.997 }
  });
  if (/not near|Ghana station|kaneshie/i.test(JSON.stringify(farLoc)) && !/14319859/i.test(JSON.stringify(farLoc)))
    pass('engine  far location is not claimed as Kasoa');
  else bad('engine far loc', JSON.stringify(farLoc).slice(0, 220));

  const nluFare = await classify('kaneshie to bubuashie');
  if (nluFare.intent === 'fare' && nluFare.via === 'regex' && nluFare.places.length >= 2)
    pass('NLU  regex still owns kaneshie to bubuashie');
  else bad('NLU regex fast path', JSON.stringify(nluFare));

  const nluTurn = await engine.handle({ from: '233201234567', hash: 'unit-nlu', text: 'turn on road updates' });
  if (/Road alerts added/i.test(JSON.stringify(nluTurn)))
    pass('NLU  turn on road updates adds the add-on');
  else bad('NLU addon turn', JSON.stringify(nluTurn).slice(0, 180));

  const catalog = require('../lib/db/catalog');
  if (catalog.NAMES.length === 22 && catalog.NAMES.includes('ai') && catalog.NAMES.includes('auth') && catalog.NAMES.includes('report_road_condition'))
    pass('neon catalog  ai + auth + report_road_condition');
  else bad('neon catalog', catalog.NAMES.join(','));

  const dbHealth = await req(server, '/v1/health/db');
  if (dbHealth.status === 200 && dbHealth.body && dbHealth.body.data && dbHealth.body.data.configured === false)
    pass('GET /v1/health/db  neon off in tests');
  else bad('GET /v1/health/db', dbHealth.status + ' ' + JSON.stringify(dbHealth.body));

  server.close();
  console.log('\n' + ok.length + ' passed, ' + fail.length + ' failed');
  if (fail.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
