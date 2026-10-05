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
const memory = require('../lib/memory');
const crowd = require('../lib/crowd');

const fail = [];
const ok = [];
function pass(name, extra) { ok.push(name); console.log('  ok  ' + name + (extra ? '  ' + extra : '')); }
function bad(name, err) { fail.push(name); console.log('  FAIL  ' + name + '  ' + err); }

function inGhana(hash) {
  const s = caps.subscriber(hash);
  s.country = 'gh';
  s.onboarded = true;
  return s;
}

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
  if (site.status === 200 && /Never stranded/i.test(site.text) && site.text.includes('id="services"') && site.text.includes('id="station-map"'))
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
  const openedType = opened[0] && opened[0].type;
  const openedAsk = JSON.stringify(opened);
  if (openedType === 'interactive' && /location_request/i.test(openedAsk) && /country/i.test(openedAsk) && /WhatsApp location|Share your location/i.test(openedAsk))
    pass('welcome  asks country via WhatsApp location');
  else bad('welcome country ask', openedType + ' ' + openedAsk.slice(0, 180));

  const typedHi = await engine.handle({ from: '233201234567', hash, text: 'Hi' });
  if (typedHi[0] && typedHi[0].type === 'interactive' && /country/i.test(JSON.stringify(typedHi)))
    pass('hi before country  still asks country');
  else bad('hi before country', JSON.stringify(typedHi).slice(0, 180));

  const ghanaIn = await engine.handle({ from: '233201234567', hash, text: 'Ghana' });
  const ghanaIds = ((ghanaIn[0] && ghanaIn[0].interactive && ghanaIn[0].interactive.action.sections) || [])
    .flatMap(s => (s.rows || []).map(r => r.id));
  if (ghanaIn[0] && ghanaIn[0].type === 'interactive' && ghanaIds.includes('addon:fuel'))
    pass('Ghana  opens the live menu');
  else bad('Ghana menu', JSON.stringify(ghanaIn).slice(0, 180));

  const afterHi = await engine.handle({ from: '233201234567', hash, text: 'Hi' });
  if (afterHi[0] && afterHi[0].type === 'text' && /Choose|road condition/i.test(afterHi[0].text && afterHi[0].text.body))
    pass('hi after Ghana  does not repeat the menu');
  else bad('hi after Ghana', JSON.stringify(afterHi).slice(0, 180));

  caps.forget('unit-usa');
  const usa = await engine.handle({ from: '233201234567', hash: 'unit-usa', text: 'USA' });
  if (/don't have data|do not have data|United States/i.test(JSON.stringify(usa)))
    pass('USA  has no country data');
  else bad('USA no data', JSON.stringify(usa).slice(0, 220));

  caps.forget('unit-usaloc');
  const usaPin = await engine.handle({
    from: '233201234567', hash: 'unit-usaloc',
    location: { latitude: 40.7128, longitude: -74.006 }
  });
  if (/don't have data|do not have data|United States/i.test(JSON.stringify(usaPin)))
    pass('USA WhatsApp location  has no country data');
  else bad('USA location', JSON.stringify(usaPin).slice(0, 220));

  inGhana('unit-roadq');
  const roadAsk = await engine.handle({ from: '233201234567', hash: 'unit-roadq', text: 'what is the road condition right now' });
  if (/Which road/i.test(JSON.stringify(roadAsk)) && !/₵/.test(JSON.stringify(roadAsk)))
    pass('what is the road condition right now asks which road');
  else bad('road question', JSON.stringify(roadAsk).slice(0, 180));

  caps.forget('unit-slash');
  inGhana('unit-slash');
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
  inGhana('unit-photo');
  const pic = await engine.handle({
    from: '233201234567',
    hash: 'unit-photo',
    type: 'image',
    image: { mime: 'image/jpeg', bytes: Buffer.from('fakejpg'), caption: 'tema motorway blocked' }
  });
  const picTxt = JSON.stringify(pic);
  if (/location_request/i.test(picTxt) && /Where are you/i.test(picTxt) && /no GPS|no location/i.test(picTxt) && /motorway|blocked|Photo saved/i.test(picTxt))
    pass('WhatsApp road photo  asks where (no GPS)');
  else bad('WhatsApp road photo', picTxt.slice(0, 220));

  const picWhere = await engine.handle({
    from: '233201234567', hash: 'unit-photo',
    location: { latitude: 5.6037, longitude: -0.1870 }
  });
  if (/contractor/i.test(JSON.stringify(picWhere)))
    pass('road photo location  then asks contractor');
  else bad('road photo location', JSON.stringify(picWhere).slice(0, 220));

  const picSkip = await engine.handle({ from: '233201234567', hash: 'unit-photo', text: 'skip' });
  if (/Logged|not stranded|ghfares.com\/roads/i.test(JSON.stringify(picSkip)))
    pass('road photo  logged after skip contractor');
  else bad('road photo skip contractor', JSON.stringify(picSkip).slice(0, 220));

  caps.forget('unit-car');
  inGhana('unit-car');
  const carPic = await engine.handle({
    from: '233201234567',
    hash: 'unit-car',
    type: 'image',
    image: { mime: 'image/jpeg', bytes: Buffer.from('fakejpg'), caption: 'this car' }
  });
  const carTxt = JSON.stringify(carPic);
  if (/photo:kind:road_condition/.test(carTxt) && /photo:kind:accident/.test(carTxt))
    pass('car photo  asks road condition or accident');
  else bad('car photo kind', carTxt.slice(0, 220));

  const carPick = await engine.handle({
    from: '233201234567', hash: 'unit-car', interactiveId: 'photo:kind:road_condition'
  });
  if (/location_request/i.test(JSON.stringify(carPick)) && /Where are you/i.test(JSON.stringify(carPick)))
    pass('picked road condition  asks where');
  else bad('picked road condition', JSON.stringify(carPick).slice(0, 220));

  const carPlace = await engine.handle({ from: '233201234567', hash: 'unit-car', text: 'Tema Motorway km 8' });
  if (/contractor/i.test(JSON.stringify(carPlace)))
    pass('typed landmark  then asks contractor');
  else bad('typed landmark', JSON.stringify(carPlace).slice(0, 220));

  const named = await engine.handle({ from: '233201234567', hash: 'unit-car', text: 'China Railway' });
  if (/China Railway/i.test(JSON.stringify(named)) && /Logged/i.test(JSON.stringify(named)))
    pass('contractor name  stored');
  else bad('contractor name', JSON.stringify(named).slice(0, 220));

  const hist = await engine.handle({ from: '233201234567', hash: 'unit-photo', text: 'my road photos' });
  if (/no road photos|Your road photos|keyed/i.test(JSON.stringify(hist)))
    pass('my road photos  history');
  else bad('road photo history', JSON.stringify(hist).slice(0, 180));

  inGhana('unit-photo-miss');
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
  inGhana('unit-pothole');
  const potholeTurn = await engine.handle({ from: '233201234567', hash: 'unit-pothole', text: 'Pothole on Kaneshie to Kasoa' });
  if (/Logged/i.test(JSON.stringify(potholeTurn)) && /pothole/i.test(JSON.stringify(potholeTurn)) && !/queued for mapping/i.test(JSON.stringify(potholeTurn)))
    pass('engine  pothole logs a road report');
  else bad('engine pothole', JSON.stringify(potholeTurn).slice(0, 220));

  const wantReport = await engine.handle({ from: '233201234567', hash: 'unit-pothole', text: 'I want to report it myself' });
  if (/Send a photo|pothole|motorway|blocked/i.test(JSON.stringify(wantReport)))
    pass('engine  I want to report it myself asks for a photo');
  else bad('engine report myself', JSON.stringify(wantReport).slice(0, 220));

  const far = api.stationsNear(47.573, -121.997);
  if (far.too_far && far.metres > 25000)
    pass('stationsNear  rejects a pin far from Ghana');
  else bad('stationsNear far', JSON.stringify({ metres: far.metres, too_far: far.too_far }));

  inGhana('unit-farloc');
  const farLoc = await engine.handle({
    from: '233201234567', hash: 'unit-farloc',
    location: { latitude: 47.573, longitude: -121.997 }
  });
  if (/not near|Ghana station|Type the station/i.test(JSON.stringify(farLoc)) && !/14319859/i.test(JSON.stringify(farLoc)))
    pass('engine  far location is not claimed as Kasoa');
  else bad('engine far loc', JSON.stringify(farLoc).slice(0, 220));

  caps.forget('unit-place');
  inGhana('unit-place');
  const locAsk = await engine.handle({ from: '233201234567', hash: 'unit-place', text: 'where' });
  if (/Share your location|say \*no\*|type any station/i.test(JSON.stringify(locAsk)))
    pass('where  asks for location or typed station');
  else bad('where location ask', JSON.stringify(locAsk).slice(0, 220));

  const saidNo = await engine.handle({ from: '233201234567', hash: 'unit-place', text: 'no' });
  if (/No problem|Type the station/i.test(JSON.stringify(saidNo)))
    pass('no  invites typed station name');
  else bad('place decline', JSON.stringify(saidNo).slice(0, 220));

  const typed = await engine.handle({ from: '233201234567', hash: 'unit-place', text: 'circle' });
  if (/Circle|Odorna|fare|₵/i.test(JSON.stringify(typed)))
    pass('typed station  after location decline');
  else bad('typed station', JSON.stringify(typed).slice(0, 220));

  caps.forget('unit-nearest');
  inGhana('unit-nearest');
  await engine.handle({ from: '233201234567', hash: 'unit-nearest', text: 'where' });
  await engine.handle({ from: '233201234567', hash: 'unit-nearest', text: 'no' });
  const unknown = await engine.handle({ from: '233201234567', hash: 'unit-nearest', text: 'Kumbungu Junction XYZ' });
  if (/Where are you now/i.test(JSON.stringify(unknown)) && /send_location/.test(JSON.stringify(unknown)))
    pass('unknown place  asks where you are now');
  else bad('unknown place', JSON.stringify(unknown).slice(0, 240));

  const snapped = await engine.handle({
    from: '233201234567', hash: 'unit-nearest',
    location: { latitude: 5.56507, longitude: -0.235921 }
  });
  if (/Kaneshie|You're at/i.test(JSON.stringify(snapped)))
    pass('nearest pin  unknown name then WhatsApp location');
  else bad('nearest pin', JSON.stringify(snapped).slice(0, 240));

  caps.forget('unit-sunyani');
  inGhana('unit-sunyani');
  const sunyani = await engine.handle({ from: '233201234567', hash: 'unit-sunyani', text: 'Sunyani Bus Station' });
  if (/Sunyani/i.test(JSON.stringify(sunyani)) && /on the map/i.test(JSON.stringify(sunyani)))
    pass('Ghana station  Sunyani is on the map without a fare table');
  else bad('sunyani station', JSON.stringify(sunyani).slice(0, 240));

  const nluFare = await classify('kaneshie to bubuashie');
  if (nluFare.intent === 'fare' && nluFare.places.length >= 2)
    pass('NLU  fare questions still resolve a from-to pair');
  else bad('NLU fare pair', JSON.stringify(nluFare));

  inGhana('unit-nlu');
  const nluTurn = await engine.handle({ from: '233201234567', hash: 'unit-nlu', text: 'turn on road updates' });
  if (/Road alerts added/i.test(JSON.stringify(nluTurn)))
    pass('NLU  turn on road updates adds the add-on');
  else bad('NLU addon turn', JSON.stringify(nluTurn).slice(0, 180));

  caps.forget('unit-memory');
  inGhana('unit-memory');
  const remembered = caps.subscriber('unit-memory');
  remembered.route = { from: 'kaneshie', to: 'bubuashie', fromName: 'Kaneshie', toName: 'Bubuashie', chart: 5 };
  caps.add('unit-memory', 'route');
  const vagueFare = await engine.handle({
    from: '233201234567', hash: 'unit-memory',
    text: 'what is the current fare from barrier to town?'
  });
  const vagueBody = JSON.stringify(vagueFare);
  if (/Which place do you mean by \*barrier\*/.test(vagueBody) && /Which place do you mean by \*town\*/.test(vagueBody)
      && /send_location/.test(vagueBody) && /Share your location/.test(vagueBody)
      && /\/loc\/[a-f0-9]{32}/.test(vagueBody) && /Type it/.test(vagueBody)
      && !/addon:menu/.test(vagueBody) && !/₵/.test(vagueBody) && !/Bubuashie/.test(vagueBody))
    pass('memory  vague barrier to town offers share, browser link, and typing');
  else bad('memory vague fare', vagueBody.slice(0, 320));

  const filled = await engine.handle({
    from: '233201234567', hash: 'unit-memory',
    text: 'kaneshie to bubuashie'
  });
  const filledBody = JSON.stringify(filled);
  if (/₵/.test(filledBody) && /Kaneshie/i.test(filledBody) && /Bubiashie/i.test(filledBody)
      && /REPORTED|ESTIMATED/.test(filledBody))
    pass('memory  follow-up Kaneshie to Bubuashie returns the fare');
  else bad('memory follow-up fare', filledBody.slice(0, 320));

  caps.forget('unit-graph');
  inGhana('unit-graph');
  const composed = await engine.handle({
    from: '233201234567', hash: 'unit-graph',
    text: 'what is the fare from madina to kaneshie'
  });
  const composedBody = JSON.stringify(composed);
  if (/COMPOSED/.test(composedBody) && /Madina Station/.test(composedBody) && /Abeka lapaz/.test(composedBody)
      && /Kaneshie Mkt Cmplx/.test(composedBody) && /₵19/.test(composedBody)
      && !/I do not have a fare/.test(composedBody))
    pass('graph  a missing direct fare is the cheapest sum of table legs');
  else bad('composed fare', composedBody.slice(0, 400));

  caps.forget('unit-talk');
  inGhana('unit-talk');
  await engine.handle({ from: '233201234567', hash: 'unit-talk', text: 'how much' });
  const mainMenu = await engine.handle({ from: '233201234567', hash: 'unit-talk', text: 'Main menu' });
  const homeCmd = await engine.handle({ from: '233201234567', hash: 'unit-talk', text: 'Home' });
  if (/Where am I|Add-on|Choose/i.test(JSON.stringify(mainMenu))
      && /Where am I|Add-on|Choose/i.test(JSON.stringify(homeCmd))
      && !/I do not have \*Main menu\*/.test(JSON.stringify(mainMenu))
      && !/I do not have \*Home\*/.test(JSON.stringify(homeCmd)))
    pass('talk  Main menu and Home are commands, not place names');
  else bad('menu command', JSON.stringify(mainMenu).slice(0, 240));

  await engine.handle({ from: '233201234567', hash: 'unit-talk', text: 'how much' });
  const petrol = await engine.handle({ from: '233201234567', hash: 'unit-talk', text: 'how much is petrol' });
  if (/Fuel watch|Fuel —|petrol/i.test(JSON.stringify(petrol)) && !/I do not have \*how much is petrol\*/i.test(JSON.stringify(petrol)))
    pass('talk  a petrol question leaves the location prompt');
  else bad('petrol during place wait', JSON.stringify(petrol).slice(0, 300));

  const pidgin = await engine.handle({
    from: '233201234567', hash: 'unit-talk', text: 'madina go kaneshie'
  });
  if (/COMPOSED/.test(JSON.stringify(pidgin)) && /₵19/.test(JSON.stringify(pidgin)))
    pass('talk  Pidgin X go Y uses the fare graph');
  else bad('pidgin route', JSON.stringify(pidgin).slice(0, 300));

  const obra = await engine.handle({
    from: '233201234567', hash: 'unit-talk', text: 'fare from obra spot to kaneshie'
  });
  if (/Circle/.test(JSON.stringify(obra)) && !/I do not have \*obra/i.test(JSON.stringify(obra)))
    pass('talk  Obra Spot is Circle');
  else bad('obra spot', JSON.stringify(obra).slice(0, 300));

  const town = await engine.handle({
    from: '233201234567', hash: 'unit-talk', text: 'what is the fare from madina to town?'
  });
  if (!/which place do you mean by \*town\*/i.test(JSON.stringify(town))
      && /Accra|REPORTED|COMPOSED|ESTIMATED/.test(JSON.stringify(town)))
    pass('talk  town follows the other place and means Accra Central');
  else bad('town context', JSON.stringify(town).slice(0, 300));

  const quoted = await engine.handle({
    from: '233201234567', hash: 'unit-talk', text: 'fare from "Barrier" to town?'
  });
  if (/barrier/i.test(JSON.stringify(quoted)) && /send_location|Share your location|Which place/i.test(JSON.stringify(quoted)))
    pass('talk  quotes are stripped and an unknown barrier still asks once');
  else bad('quoted barrier', JSON.stringify(quoted).slice(0, 300));

  const typo = await engine.handle({ from: '233201234567', hash: 'unit-talk', text: 'circe' });
  if (/Did you mean/i.test(JSON.stringify(typo)) && /Circle/.test(JSON.stringify(typo)) && /did:/.test(JSON.stringify(typo)))
    pass('talk  a close typo offers Did you mean');
  else bad('did you mean', JSON.stringify(typo).slice(0, 300));

  const unknownFare = await engine.handle({
    from: '233201234567', hash: 'unit-talk', text: 'fare from xyzqplace to circle'
  });
  const looked = crowd.review();
  if (/xyzqplace/i.test(JSON.stringify(unknownFare))
      && looked.unknown.some(row => row.name === 'xyzqplace')
      && looked.misses.some(row => /madina go kaneshie/i.test(row.name)))
    pass('talk  unknown names and a quick rephrase are logged for review');
  else bad('review log', JSON.stringify({ unknown: looked.unknown, misses: looked.misses }).slice(0, 300));

  if (engine.reactionId('👍🏾') === 'sig:up' && engine.reactionId('👎') === 'sig:down' && engine.reactionId('') === null)
    pass('talk  a thumbs reaction is the same signal as Like or Dislike');
  else bad('reaction', 'emoji did not map');

  const log = memory.recent('unit-memory');
  if (log.filter(m => m.direction === 'in').some(m => /barrier to town/i.test(m.body))
      && log.filter(m => m.direction === 'in').some(m => /kaneshie to bubuashie/i.test(m.body))
      && log.some(m => m.direction === 'out' && /barrier/i.test(m.body)))
    pass('memory  user and reply messages stay on the chat');
  else bad('memory log', JSON.stringify(log).slice(0, 320));

  caps.forget('unit-memory');
  if (memory.recent('unit-memory').length === 0 && !memory.thread('unit-memory'))
    pass('memory  delete my data clears the chat memory');
  else bad('memory forget', JSON.stringify(memory.recent('unit-memory')).slice(0, 180));

  caps.forget('unit-barrier');
  inGhana('unit-barrier');
  const fate = await engine.handle({
    from: '233201234567', hash: 'unit-barrier',
    text: 'What is the current fate from barrier to town'
  });
  if (/Which place do you mean by \*barrier\*/.test(JSON.stringify(fate)) && /town/.test(JSON.stringify(fate)))
    pass('memory  fate typo still asks which barrier and which town');
  else bad('memory fate', JSON.stringify(fate).slice(0, 240));

  const barrierStation = await engine.handle({
    from: '233201234567', hash: 'unit-barrier',
    text: 'Barrier station'
  });
  const barrierBody = JSON.stringify(barrierStation);
  if (/Barrier Station\* is a stop/.test(barrierBody) && /Which place do you mean by \*town\*/.test(barrierBody)
      && !/Which place do you mean by \*barrier\*/.test(barrierBody))
    pass('memory  Barrier station answers the first question and asks only for town');
  else bad('memory barrier station', barrierBody.slice(0, 400));

  caps.forget('unit-barrier-stop');
  inGhana('unit-barrier-stop');
  await engine.handle({
    from: '233201234567', hash: 'unit-barrier-stop',
    text: 'what is the current fare from barrier to town?'
  });
  const barrierStop = await engine.handle({
    from: '233201234567', hash: 'unit-barrier-stop',
    text: 'Barrier stop'
  });
  const stopBody = JSON.stringify(barrierStop);
  if (/matches more than one place/.test(stopBody) && /Ofankor Barrier/.test(stopBody) && /Choose place/.test(stopBody)
      && !/Which place do you mean by \*barrier\*/.test(stopBody))
    pass('memory  Barrier stop lists the barrier places instead of repeating the question');
  else bad('memory barrier stop', stopBody.slice(0, 400));

  caps.forget('unit-barrier-pin');
  inGhana('unit-barrier-pin');
  await engine.handle({
    from: '233201234567', hash: 'unit-barrier-pin',
    text: 'what is the current fare from barrier to town?'
  });
  const barrierPin = await engine.handle({
    from: '233201234567', hash: 'unit-barrier-pin',
    location: { latitude: 5.65783, longitude: -0.267935 }
  });
  const pinBody = JSON.stringify(barrierPin);
  if (/Barrier Station/.test(pinBody) && /0 m from you/.test(pinBody) && /still need \*town\*/.test(pinBody)
      && !/Which place do you mean by \*barrier\*/.test(pinBody))
    pass('memory  shared location picks the nearest barrier and asks for the town');
  else bad('memory barrier pin', pinBody.slice(0, 400));

  caps.forget('unit-browser');
  inGhana('unit-browser');
  const browserAsk = await engine.handle({
    from: '233201234567', hash: 'unit-browser',
    text: 'what is the current fare from barrier to town?'
  });
  const locToken = (JSON.stringify(browserAsk).match(/\/loc\/([a-f0-9]{32})/) || [])[1];
  const locPage = locToken && await req(server, '/loc/' + locToken);
  const locPost = locToken && await req(server, '/v1/loc/' + locToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ latitude: 5.65783, longitude: -0.267935 })
  });
  const locReply = JSON.stringify(locPost && locPost.body);
  if (locPage && locPage.status === 200 && /Use this phone/.test(locPage.text)
      && locPost && locPost.status === 200 && /Barrier Station/.test(locReply) && /town/.test(locReply))
    pass('location link  browser GPS answers the open fare question');
  else bad('location link', (locPage && locPage.status) + ' ' + locReply.slice(0, 280));

  const locAdd = await engine.handle({
    from: '233201234567', hash: 'unit-browser',
    text: 'ADD MY LOCATION'
  });
  const locAddBody = JSON.stringify(locAdd);
  if (/My location/.test(locAddBody) && /send_location/.test(locAddBody) && /\/loc\//.test(locAddBody) && /Type it/.test(locAddBody))
    pass('add-on  MY LOCATION offers share, browser, and typing');
  else bad('my location add-on', locAddBody.slice(0, 320));

  caps.forget('unit-fuel-address');
  inGhana('unit-fuel-address');
  const pump = await engine.handle({
    from: '233200000051', hash: 'unit-fuel-address', interactiveId: 'fuelstation:goil-tema1'
  });
  const address = await engine.handle({
    from: '233200000051', hash: 'unit-fuel-address', text: 'Address'
  });
  const addressBody = JSON.stringify(address);
  const pinClass = await classify('share my location');
  const nickClass = await classify('nkrumah to kasoa');
  const twiClass = await classify('military hospital station');
  if (pinClass.intent === 'where'
      && nickClass.intent === 'fare' && (nickClass.places || []).includes('circle') && (nickClass.places || []).some(p => String(p).includes('kasoa'))
      && twiClass.intent === 'station' && (twiClass.places || []).includes('37'))
    pass('skills  a pin is location, and Circle, 37, and Nkrumah are the informal names');
  else bad('location and names', JSON.stringify({ pin: pinClass.intent, nick: nickClass, hospital: twiClass }));

  const addressClass = await classify('Address');
  if (/GOIL Tema Community 1/.test(JSON.stringify(pump))
      && /GOIL Tema Community 1/.test(addressBody) && /Tema/.test(addressBody)
      && /maps\/search/.test(addressBody) && !/add-on called/.test(addressBody)
      && addressClass.intent !== 'addon_add')
    pass('context  Address after a fuel card is that pump, not an add-on');
  else bad('fuel address', addressBody.slice(0, 280) + ' ' + addressClass.intent);

  const priceFollow = await engine.handle({
    from: '233200000051', hash: 'unit-fuel-address', text: 'how much is the petrol'
  });
  if (/15\.25/.test(JSON.stringify(priceFollow)) && /GOIL Tema Community 1/.test(JSON.stringify(priceFollow)))
    pass('context  how much is the petrol stays on the open pump');
  else bad('petrol follow-up', JSON.stringify(priceFollow).slice(0, 280));

  caps.forget('unit-gas-thread');
  inGhana('unit-gas-thread');
  await engine.handle({
    from: '233200000061', hash: 'unit-gas-thread',
    text: 'what is the current fare from barrier to town?'
  });
  const gasLines = [
    'Gas prices at tema foil station community 1',
    'Tema Goil community 1',
    'Goil tema community 1',
    'What gas prices do you have'
  ];
  const gasBodies = [];
  for (const text of gasLines) {
    gasBodies.push(JSON.stringify(await engine.handle({
      from: '233200000061', hash: 'unit-gas-thread', text
    })));
  }
  const gasClass = await classify('Gas prices at tema foil station community 1');
  if (gasClass.intent === 'fuel' && gasClass.fuelId === 'goil-tema1'
      && gasBodies.every(body => /Fuel watch/.test(body) && /ADD FUEL/.test(body) && !/on the map/.test(body) && !/\/loc\//.test(body))
      && gasBodies.slice(0, 3).every(body => /15\.25/.test(body) && /GOIL Tema Community 1/.test(body) && /Unverified/.test(body) && !/11 riders/.test(body) && !/Confirm\s+11/.test(body))
      && !/15\.25/.test(gasBodies[3]))
    pass('conversation  gas prices beat an open fare and point at Fuel watch');
  else bad('gas during fare', gasClass.intent + ' ' + gasClass.fuelId + ' ' + gasBodies.map(b => b.slice(0, 180)).join(' | '));

  const temaFuel = JSON.stringify(await engine.handle({
    from: '233200000061', hash: 'unit-gas-thread', text: 'Tema'
  }));
  if (/Fuel — Tema/.test(temaFuel) && /GOIL Tema Community 1/.test(temaFuel) && !/on the map/.test(temaFuel) && !/11 riders/.test(temaFuel))
    pass('conversation  Tema after the fuel prompt lists Tema pumps');
  else bad('tema after fuel', temaFuel.slice(0, 280));

  caps.forget('unit-fuel-ask');
  caps.forget('unit-fuel-peer-a');
  caps.forget('unit-fuel-peer-b');
  inGhana('unit-fuel-ask');
  inGhana('unit-fuel-peer-a');
  inGhana('unit-fuel-peer-b');
  caps.subscriber('unit-fuel-ask').station = 'kaneshie';
  caps.subscriber('unit-fuel-ask').reach = '233200001001';
  caps.subscriber('unit-fuel-peer-a').station = 'kaneshie';
  caps.subscriber('unit-fuel-peer-a').reach = '233200001002';
  caps.subscriber('unit-fuel-peer-b').station = 'kaneshie';
  caps.subscriber('unit-fuel-peer-b').reach = '233200001003';
  const fuelAsk = await engine.handle({
    from: '233200001001', hash: 'unit-fuel-ask', text: 'GOIL Tema Community 1'
  });
  const fuelAskBody = JSON.stringify(fuelAsk);
  const fuelCheckId = (fuelAskBody.match(/fuelcheck:yes:([a-z0-9]+)/) || [])[1];
  const ownVote = fuelCheckId && await engine.handle({
    from: '233200001001', hash: 'unit-fuel-ask', interactiveId: 'fuelcheck:yes:' + fuelCheckId
  });
  const peerVote = fuelCheckId && await engine.handle({
    from: '233200001002', hash: 'unit-fuel-peer-a', interactiveId: 'fuelcheck:yes:' + fuelCheckId
  });
  const peerVote2 = fuelCheckId && await engine.handle({
    from: '233200001003', hash: 'unit-fuel-peer-b', interactiveId: 'fuelcheck:yes:' + fuelCheckId
  });
  if (/Unverified/.test(fuelAskBody) && /I asked \*2\* riders/.test(fuelAskBody) && /Kaneshie/.test(fuelAskBody)
      && !/11 riders/.test(fuelAskBody) && fuelCheckId
      && /cannot confirm your own/.test(JSON.stringify(ownVote))
      && /waiting for two other riders/.test(JSON.stringify(peerVote))
      && /shows \*2\* rider confirmations/.test(JSON.stringify(peerVote2)))
    pass('fuel  a price check is sent to other riders at the station and the seed count is not shown');
  else bad('fuel confirmations', fuelAskBody.slice(0, 240) + ' own=' + JSON.stringify(ownVote).slice(0, 120) + ' peer=' + JSON.stringify(peerVote2).slice(0, 160));

  const noContext = [
    ['How much?', /Where are you now/, /Fuel watch|ADD FUEL|You're at/],
    ['how much is the fare', /Where are you now/, /Fuel watch|ADD FUEL|You're at/],
    ['Charley how much be the trotro', /Where are you now/, /Fuel watch|ADD FUEL/],
    ['wo bay jay sen', /Where are you now/, /Kasoa|Fuel watch/],
    ['I dont know how much I will pay', /Where are you now/, /Fuel watch|ADD FUEL/],
    ['What is the price of fuel in Accra today', /Fuel — Accra/, /You're at/],
    ['how much is petrol', /Fuel watch/, /You're at/],
    ['how much is diesel', /Fuel watch/, /You're at/],
    ['how much is dropping', /Where are you now/, /Fuel watch|ADD FUEL/],
    ['mate how much', /Where are you now/, /You're at Circle|Fuel watch/]
  ];
  let noContextOk = true;
  const noContextFail = [];
  for (let i = 0; i < noContext.length; i++) {
    const [text, want, forbid] = noContext[i];
    const hash = 'unit-nocontext-' + i;
    caps.forget(hash);
    inGhana(hash);
    const body = JSON.stringify(await engine.handle({ from: '233200009900', hash, text }));
    if (!want.test(body) || forbid.test(body)) {
      noContextOk = false;
      noContextFail.push(text + ' ' + body.slice(0, 160));
    }
  }
  const pig = await classify('how much to pig farm');
  const temaStation = await classify('from tema station to madina');
  if (noContextOk
      && (pig.places || []).includes('pig-farm-station')
      && (temaStation.places || []).includes('accra')
      && (temaStation.places || []).some(p => String(p).includes('madina')))
    pass('conversation  a fare with no place asks for the route and does not borrow a town');
  else bad('no context', noContextFail.join(' | ') + ' pig=' + JSON.stringify(pig.places) + ' tema=' + JSON.stringify(temaStation.places));

  const curveballs = [
    ['how much be am o', /Where are you now/, /Fuel watch|You're at/],
    ['how much be the petrol now', /Fuel watch/, /You're at|Where are you now/],
    ['any wahala at all', /Which road/, /Fuel watch|You're at/],
    ['mate dey overcharge me', /Where are you now/, /Fuel watch|You're at/],
    ['the cars no dey move', /Where are you now/, /Fuel watch|You're at Circle/]
  ];
  let curveOk = true;
  const curveFail = [];
  for (let i = 0; i < curveballs.length; i++) {
    const [text, want, forbid] = curveballs[i];
    const hash = 'unit-curve-' + i;
    caps.forget(hash);
    inGhana(hash);
    const body = JSON.stringify(await engine.handle({ from: '233200008800', hash, text }));
    if (!want.test(body) || forbid.test(body)) {
      curveOk = false;
      curveFail.push(text + ' ' + body.slice(0, 180));
    }
  }
  if (curveOk)
    pass('conversation  unfinished Ghanaian lines keep the subject and ask for the missing place');
  else bad('curveball', curveFail.join(' | '));

  caps.forget('unit-circle');
  inGhana('unit-circle');
  await engine.handle({
    from: '233201234567', hash: 'unit-circle',
    text: 'what is the current fare from barrier to town?'
  });
  await engine.handle({ from: '233201234567', hash: 'unit-circle', text: 'Barrier stop' });
  const circleTown = await engine.handle({ from: '233201234567', hash: 'unit-circle', text: 'Circle' });
  const circleBody = JSON.stringify(circleTown);
  if (/Circle\* is the town/.test(circleBody) && /Ofankor Barrier/.test(circleBody) && /Choose place/.test(circleBody)
      && !/From \*Circle\*/.test(circleBody))
    pass('memory  Circle during a barrier list is the town');
  else bad('circle during barrier list', circleBody.slice(0, 400));

  caps.forget('unit-namer');
  inGhana('unit-namer');
  await engine.handle({
    from: '233200000021', hash: 'unit-namer',
    text: 'what is the fare from barrier to town?'
  });
  const unknownName = await engine.handle({ from: '233200000021', hash: 'unit-namer', text: 'kpakpo' });
  const namedPin = await engine.handle({
    from: '233200000021', hash: 'unit-namer',
    location: { latitude: 5.56507, longitude: -0.235921 }
  });
  const namedBody = JSON.stringify(unknownName) + JSON.stringify(namedPin);
  const namedStation = caps.subscriber('unit-namer').station;
  inGhana('unit-namer-2');
  caps.subscriber('unit-namer-2').station = namedStation;
  await engine.handle({
    from: '233200000022', hash: 'unit-namer-2',
    text: 'what is the fare from barrier to town?'
  });
  await engine.handle({ from: '233200000022', hash: 'unit-namer-2', text: 'kpakpo' });
  if (/do not have \*kpakpo\*/.test(namedBody) && /send_location/.test(namedBody) && /pending/.test(namedBody)
      && crowd.resolveName('kpakpo') === namedStation && crowd.score('unit-namer').points === 2
      && !require('../lib/api').PLACES.kpakpo)
    pass('names  a local name stays pending until a second rider at that station agrees');
  else bad('community name', namedBody.slice(0, 280) + ' ' + crowd.resolveName('kpakpo') + ' ' + crowd.score('unit-namer').points);

  caps.forget('unit-place');
  const seedKasoa = JSON.stringify(api.core.gouging['circle:kasoa']);
  const seedMadina = JSON.stringify(api.core.gouging['circle:madina']);
  caps.forget('unit-lone');
  const lone = inGhana('unit-lone');
  lone.pending = { from: 'circle', to: 'osu-blow-up' };
  const loneReply = await engine.handle({ from: '233200000031', hash: 'unit-lone', text: '12' });
  const loneBody = JSON.stringify(loneReply);
  if (/only rider at this station/.test(loneBody) && /unverified/.test(loneBody) && !/\+/.test(loneBody)
      && seedKasoa === JSON.stringify(api.core.gouging['circle:kasoa'])
      && seedMadina === JSON.stringify(api.core.gouging['circle:madina']))
    pass('verify  a lone fare report stays unverified and does not replace the chart');
  else bad('lone fare', loneBody.slice(0, 320));

  const station = 'circle';
  const peerA = inGhana('unit-peer-a');
  peerA.station = station; peerA.reach = '233200000041'; peerA.seen = Date.now();
  const peerB = inGhana('unit-peer-b');
  peerB.station = station; peerB.reach = '233200000042'; peerB.seen = Date.now();
  const author = inGhana('unit-peer-author');
  author.pending = { from: 'circle', to: 'dansoman-laststop' };
  author.station = station;
  const filed = await engine.handle({ from: '233200000040', hash: 'unit-peer-author', text: '11' });
  const filedBody = JSON.stringify(filed);
  const reportId = (filedBody.match(/verify:yes:([a-z0-9]+)/) || [])[1];
  const one = reportId && await engine.handle({
    from: '233200000041', hash: 'unit-peer-a', interactiveId: 'verify:yes:' + reportId
  });
  const two = reportId && await engine.handle({
    from: '233200000042', hash: 'unit-peer-b', interactiveId: 'verify:yes:' + reportId
  });
  const agreedKey = api.core.gouging['circle:dansoman-laststop'];
  const fareLine = await engine.handle({
    from: '233200000040', hash: 'unit-peer-author', text: 'fare from circle to dansoman laststop'
  });
  if (/asked \*2\*/i.test(filedBody) && /unverified/.test(filedBody) && !/\+/.test(filedBody)
      && /waiting for two/.test(JSON.stringify(one))
      && /Agreed/.test(JSON.stringify(two))
      && agreedKey && agreedKey.agreed && agreedKey.reports === 1
      && crowd.score('unit-peer-author').points === 4
      && crowd.score('unit-peer-a').points === 2
      && /over chart/.test(JSON.stringify(fareLine)))
    pass('verify  two other riders agree before a percentage is shown');
  else bad('peer verify', filedBody.slice(0, 240));

  const liked = await engine.handle({
    from: '233200000040', hash: 'unit-peer-author', interactiveId: 'sig:down'
  });
  const chartAfter = api.fare('circle', 'dansoman-laststop');
  if (/does not change the fare/.test(JSON.stringify(liked))
      && /Was this reply useful/.test(JSON.stringify(fareLine))
      && chartAfter && chartAfter.to && chartAfter.to.chart === 9)
    pass('signals  a dislike is stored and the fare stays the chart amount');
  else bad('signal', JSON.stringify(liked).slice(0, 180));

  const historyApi = await req(server, '/v1/fare-history?from=circle&to=dansoman-laststop');
  const historyPage = await req(server, '/history');
  const historyPoints = historyApi.body && historyApi.body.data && historyApi.body.data.points;
  if (historyApi.status === 200 && historyPoints && historyPoints.length === 1 && historyPoints[0].amount === 11
      && historyPage.status === 200 && /Agreed fares/.test(historyPage.text || ''))
    pass('fare history  agreed amounts are on the public graph');
  else bad('fare history', historyApi.status + ' ' + JSON.stringify(historyPoints) + ' ' + historyPage.status);

  const catalog = require('../lib/db/catalog');
  if (catalog.NAMES.length === 31 && ['survey', 'ai', 'countries', 'road_photos', 'memory', 'names', 'verify', 'xp', 'fare_history', 'signals'].every(n => catalog.NAMES.includes(n)))
    pass('neon catalog  one database per concern, including peer data');
  else bad('neon catalog', catalog.NAMES.join(','));

  const roadsApi = await req(server, '/v1/roads');
  const roadsData = roadsApi.body && roadsApi.body.data;
  if (roadsApi.status === 200 && roadsData && Array.isArray(roadsData.roads) && Array.isArray(roadsData.accidents)
      && roadsData.roads.some(r => /China Railway/i.test(r.contractor || '')))
    pass('GET /v1/roads  lists bad roads and contractor');
  else bad('GET /v1/roads', roadsApi.status + ' ' + JSON.stringify(roadsData).slice(0, 240));

  const roadsPage = await req(server, '/roads');
  if (roadsPage.status === 200 && /Never stranded|contractor|Help others/i.test(String(roadsPage.body || roadsPage.text || '')))
    pass('GET /roads  public help-others page');
  else bad('GET /roads', roadsPage.status + ' ' + String(roadsPage.body || '').slice(0, 120));

  const mapPage = await req(server, '/map');
  const mapData = await req(server, '/data/accra-station-stops.review.json');
  const pins = await req(server, '/v1/map/stations');
  const pinRows = pins.body && pins.body.data && pins.body.data.stations;
  const beyondAccra = Array.isArray(pinRows) && pinRows.some(s => s.lat > 7 || s.lat < 5);
  if (mapPage.status === 200 && /Accra station stops/.test(mapPage.text || '')
      && mapData.status === 200 && mapData.body && mapData.body.counts && mapData.body.counts.stations === 190
      && pins.status === 200 && Array.isArray(pinRows) && pinRows.length > 190 && beyondAccra)
    pass('GET /map  review map and Ghana station pins');
  else bad('GET /map', mapPage.status + ' pins ' + (pinRows && pinRows.length));

  const dbHealth = await req(server, '/v1/health/db');
  if (dbHealth.status === 200 && dbHealth.body && dbHealth.body.data && dbHealth.body.data.configured === false)
    pass('GET /v1/health/db  neon off in tests');
  else bad('GET /v1/health/db', dbHealth.status + ' ' + JSON.stringify(dbHealth.body));

  server.close();
  const tools = require('../lib/tools');
  const nlu = require('../lib/nlu');
  const toolNames = tools.schemas.map(s => s.function.name);
  if (['conversation', 'resolve_place', 'plan_fare', 'fuel_prices', 'road_status', 'queue_status', 'charts', 'addons', 'needs', 'route_stops', 'at_place'].every(n => toolNames.includes(n)))
    pass('tools  fare, fuel, roads, queue, chart, add-ons, and unfinished questions each have a tool');
  else bad('tool schemas', toolNames.join(','));

  const platform = require('../lib/platform-graph');
  const graphCounts = platform.counts();
  if (graphCounts.place >= 527 && graphCounts.fare >= 340 && graphCounts.stop > 1000
      && graphCounts.pump >= 1 && graphCounts.road >= 1 && graphCounts.chart >= 1
      && graphCounts.addon === 7 && graphCounts.reads > 0)
    pass('graph  places, stops, fares, fuel, roads, charts, and add-ons are one graph');
  else bad('platform graph', JSON.stringify(graphCounts));

  const sunyaniNode = platform.around('sunyani-bus-station');
  const abelemkpeNode = platform.around('abelemkpe-station');
  const fuelWalk = tools.execute('fuel_prices', { area: 'Tema' });
  const roadWalk = tools.execute('road_status', { road: 'Tema Motorway' });
  const chartWalk = tools.execute('charts', {});
  const addonWalk = tools.execute('addons', { text: 'road alerts', action: 'add' });
  if (sunyaniNode && sunyaniNode.departures.length === 0 && sunyaniNode.arrivals.length === 0
      && abelemkpeNode && abelemkpeNode.arrivals.some(e => e.fare === 9)
      && fuelWalk.graph === 'fuel' && fuelWalk.rows.length && fuelWalk.rows.every(r => !('confirmations' in r))
      && roadWalk.graph === 'road' && roadWalk.incidents.length === 0
      && chartWalk.graph === 'chart' && chartWalk.charts.length >= 1
      && addonWalk.graph === 'addon' && addonWalk.id === 'roads' && addonWalk.reads > 0)
    pass('graph  each tool walks its own edges and does not invent a fare');
  else bad('graph walk', JSON.stringify({ sunyaniNode, fuel: fuelWalk.graph, road: roadWalk.incidents.length, addon: addonWalk }).slice(0, 400));

  const composedPlan = tools.plan('madina go kaneshie');
  const fareCall = composedPlan.calls.find(c => c.name === 'plan_fare');
  if (composedPlan.calls.some(c => c.name === 'resolve_place') && fareCall && fareCall.result.kind === 'composed' && fareCall.result.total === 19)
    pass('tools  a route question calls plan_fare and the graph returns ₵19');
  else bad('tool fare', JSON.stringify(composedPlan).slice(0, 300));

  const informal = tools.plan('how much');
  if (informal.calls.length === 1 && informal.calls[0].name === 'needs' && informal.calls[0].result.missing === 'place'
      && !informal.calls.some(c => c.name === 'plan_fare') && !/total/.test(JSON.stringify(informal.calls[0].result)))
    pass('tools  an unfinished fare question asks for the place and does not price it');
  else bad('tool informal', JSON.stringify(informal));

  const petrolPlan = tools.plan('how much is petrol');
  const fuelCall = petrolPlan.calls.find(c => c.name === 'fuel_prices');
  const fuelRows = fuelCall && fuelCall.result.rows || [];
  if (petrolPlan.intent === 'fuel' && fuelRows.length && fuelRows.every(r => r.petrol != null && !('confirmations' in r))
      && !petrolPlan.calls.some(c => c.name === 'resolve_place'))
    pass('tools  a petrol question calls fuel_prices and does not look up a place');
  else bad('tool fuel', JSON.stringify(petrolPlan).slice(0, 300));

  const roadAddon = tools.plan('turn on road alerts');
  if (roadAddon.calls[0] && roadAddon.calls[0].name === 'addons' && roadAddon.calls[0].result.id === 'roads')
    pass('tools  turning on road alerts calls the add-on tool');
  else bad('tool addon', JSON.stringify(roadAddon));

  const wahala = tools.plan('any wahala');
  if (wahala.calls[0] && wahala.calls[0].name === 'needs' && wahala.calls[0].result.subject === 'road')
    pass('tools  an unfinished road question asks which road');
  else bad('tool road', JSON.stringify(wahala));

  const bay = tools.plan('the cars dey move');
  if (bay.calls[0] && bay.calls[0].name === 'needs' && bay.calls[0].result.subject === 'queue')
    pass('tools  an unfinished queue question asks for the station');
  else bad('tool queue', JSON.stringify(bay));

  const chartPlan = tools.plan('what chart');
  if (chartPlan.calls[0] && chartPlan.calls[0].name === 'charts' && Array.isArray(chartPlan.calls[0].result.charts))
    pass('tools  a chart question reads the loaded charts');
  else bad('tool chart', JSON.stringify(chartPlan).slice(0, 200));

  const menuPlan = tools.plan('Main menu');
  if (menuPlan.calls.length === 1 && menuPlan.calls[0].name === 'conversation' && !menuPlan.calls.some(c => c.name === 'resolve_place'))
    pass('tools  Main menu is a conversation tool, not a place lookup');
  else bad('tool menu', JSON.stringify(menuPlan));

  const injected = tools.executeCall({ name: 'plan_fare', arguments: '{"from":"madina","to":"kaneshie","total":1}' });
  if (injected.total === 19 && injected.kind === 'composed')
    pass('tools  a fare the model tries to pass in is ignored');
  else bad('tool inject', JSON.stringify(injected).slice(0, 200));

  const payload = nlu.toolRequest('how much is petrol');
  const payloadText = JSON.stringify(payload);
  if (payload.reasoning_effort === 'low' && payload.tools.length === 11
      && !/answer only from the provided context/i.test(payloadText))
    pass('tools  the model request offers the tools and does not forbid thinking');
  else bad('tool request', payloadText.slice(0, 240));

  caps.forget('unit-tools');
  inGhana('unit-tools');
  await engine.handle({ from: '233201234567', hash: 'unit-tools', text: 'how much is diesel' });
  if (engine.lastParse.toolCalls && engine.lastParse.toolCalls.includes('fuel_prices'))
    pass('tools  the chat runs the fuel tool before it replies');
  else bad('engine tools', JSON.stringify(engine.lastParse && engine.lastParse.toolCalls));

  const motorway = tools.plan('what is the road condition on the tema motorway');
  const roadCall = motorway.calls.find(c => c.name === 'road_status');
  if (roadCall && Array.isArray(roadCall.result.incidents) && !motorway.calls.some(c => c.name === 'plan_fare'))
    pass('tools  a road question calls road_status and does not price a fare');
  else bad('tool motorway', JSON.stringify(motorway).slice(0, 300));

  const potholePlan = tools.plan('pothole on kaneshie to kasoa');
  if (potholePlan.calls.some(c => c.name === 'road_status') && !potholePlan.calls.some(c => c.name === 'plan_fare'))
    pass('tools  a pothole on a route is a road, not a fare');
  else bad('tool pothole', JSON.stringify(potholePlan.calls.map(c => c.name)));

  const bareRoad = await engine.handle({
    from: '233201234567', hash: 'unit-tools', text: 'what is the road condition right now'
  });
  if (/Which road/.test(JSON.stringify(bareRoad))
      && engine.lastParse.toolCalls.includes('needs')
      && !engine.lastParse.toolCalls.includes('plan_fare'))
    pass('tools  an unfinished road question asks which road');
  else bad('engine road needs', JSON.stringify(engine.lastParse.toolCalls));

  const namedRoad = await engine.handle({
    from: '233201234567', hash: 'unit-tools', text: 'what is the road condition on the tema motorway'
  });
  if (/Nothing reported|Tema Motorway/i.test(JSON.stringify(namedRoad))
      && engine.lastParse.toolCalls.includes('road_status')
      && !engine.lastParse.toolCalls.includes('plan_fare')
      && !/COMPOSED/.test(JSON.stringify(namedRoad)))
    pass('tools  a named road is answered from road_status');
  else bad('engine road', JSON.stringify(namedRoad).slice(0, 240) + ' ' + JSON.stringify(engine.lastParse.toolCalls));

  const queueAsk = await engine.handle({
    from: '233201234567', hash: 'unit-tools', text: 'how is the queue at circle'
  });
  if (engine.lastParse.toolCalls.includes('queue_status')
      && !engine.lastParse.toolCalls.includes('plan_fare')
      && /Circle|loading|bay|No data/i.test(JSON.stringify(queueAsk)))
    pass('tools  a queue question is answered from queue_status');
  else bad('engine queue', JSON.stringify(engine.lastParse.toolCalls) + ' ' + JSON.stringify(queueAsk).slice(0, 180));

  const chartAsk = await engine.handle({
    from: '233201234567', hash: 'unit-tools', text: 'what chart'
  });
  if (engine.lastParse.toolCalls.includes('charts')
      && /Fare charts|GPRTU|survey/i.test(JSON.stringify(chartAsk))
      && !engine.lastParse.toolCalls.includes('plan_fare'))
    pass('tools  a chart question is answered from the charts tool');
  else bad('engine chart', JSON.stringify(engine.lastParse.toolCalls) + ' ' + JSON.stringify(chartAsk).slice(0, 180));

  caps.forget('unit-stops');
  inGhana('unit-stops');
  const stopList = await engine.handle({
    from: '233201234567', hash: 'unit-stops',
    text: 'what stops are on kasoa to abossey okai'
  });
  const legStopsBody = JSON.stringify(stopList);
  const sccAt = legStopsBody.indexOf('SCC');
  const sakamanAt = legStopsBody.indexOf('Sakaman Junction');
  if (/Stops on Kasoa Station/.test(legStopsBody) && /Terminal Kasoa Station/.test(legStopsBody)
      && sccAt > 0 && sakamanAt > sccAt && /no fare for each stop/i.test(legStopsBody)
      && !/₵/.test(legStopsBody) && engine.lastParse.toolCalls.includes('route_stops'))
    pass('stops  a route lists stop names in stored order with no fare');
  else bad('stop list', legStopsBody.slice(0, 400));

  const atKasoa = await engine.handle({
    from: '233201234567', hash: 'unit-stops', text: 'am at kasoa'
  });
  const kasoaBody = JSON.stringify(atKasoa);
  if (/You're at Kasoa Station/.test(kasoaBody) && !/Where are you now/.test(kasoaBody)
      && engine.lastParse.toolCalls.includes('at_place'))
    pass('stops  am at Kasoa opens Kasoa Station');
  else bad('at kasoa', kasoaBody.slice(0, 300));

  const atStop = await engine.handle({
    from: '233201234567', hash: 'unit-stops', text: 'am at sakaman junction'
  });
  const atStopBody = JSON.stringify(atStop);
  if (/Sakaman Junction/.test(atStopBody) && /Kasoa Station/.test(atStopBody)
      && /Abossey Okai Camara Station/.test(atStopBody) && /ESTIMATED/.test(atStopBody)
      && /₵11/.test(atStopBody) && /whole leg/i.test(atStopBody))
    pass('stops  a stop on one leg shows that station-to-station fare');
  else bad('at stop', atStopBody.slice(0, 400));

  const atMany = await engine.handle({
    from: '233201234567', hash: 'unit-stops', text: 'am at flat top'
  });
  const manyBody = JSON.stringify(atMany);
  if (/more than one route/.test(manyBody) && /stopleg:/.test(manyBody)
      && /Achimota Station/.test(manyBody) && !/₵/.test(manyBody))
    pass('stops  a stop on several legs offers those routes');
  else bad('at many', manyBody.slice(0, 400));

  const picked = await engine.handle({
    from: '233201234567', hash: 'unit-stops',
    interactiveId: 'stopleg:kasoa-station:abossey-okai-camara-station:S109'
  });
  if (/ESTIMATED/.test(JSON.stringify(picked)) && /₵11/.test(JSON.stringify(picked)) && /whole leg/i.test(JSON.stringify(picked)))
    pass('stops  picking a leg shows the whole-leg fare');
  else bad('pick leg', JSON.stringify(picked).slice(0, 300));

  const atPin = await engine.handle({
    from: '233201234567', hash: 'unit-sunyani', text: 'am at Sunyani Bus Station'
  });
  const mapPinBody = JSON.stringify(atPin);
  if (/Sunyani Bus Station/.test(mapPinBody) && /on the map/.test(mapPinBody)
      && !/Where are you now/.test(mapPinBody) && !/₵/.test(mapPinBody))
    pass('map pins  a pin with no fare table is on the map');
  else bad('map pin', mapPinBody.slice(0, 400));

  const atDest = await engine.handle({
    from: '233201234567', hash: 'unit-stops', text: 'am at Abelemkpe Station'
  });
  const mapDestBody = JSON.stringify(atDest);
  if (/Abelemkpe Station/.test(mapDestBody) && /ESTIMATED/.test(mapDestBody) && /₵9/.test(mapDestBody)
      && /station-to-station fare/.test(mapDestBody) && !/Where are you now/.test(mapDestBody))
    pass('map pins  a destination pin shows the recorded whole-leg fare');
  else bad('map dest', mapDestBody.slice(0, 400));

  const atHome = await engine.handle({
    from: '233201234567', hash: 'unit-stops', text: 'am at home'
  });
  if (/home/i.test(JSON.stringify(atHome)) && /Where are you now/.test(JSON.stringify(atHome))
      && !/Welcome to GH Fares/.test(JSON.stringify(atHome)))
    pass('stops  am at home asks where that is and does not open the menu');
  else bad('at home', JSON.stringify(atHome).slice(0, 300));

  console.log('\n' + ok.length + ' passed, ' + fail.length + ' failed');
  if (fail.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
