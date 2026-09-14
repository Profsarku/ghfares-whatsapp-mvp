/**
 * Live phone mimic — landing, webhook, Graph status, and a WhatsApp-shaped
 * conversation through POST /v1/ask (same engine the webhook calls).
 *
 *   $env:BASE='https://ghfares-whatsapp-mvp.vercel.app'; node --use-system-ca test/phone-mimic.js
 */
const BASE = process.env.BASE || 'https://ghfares-whatsapp-mvp.vercel.app';
const fail = [];
const ok = [];
function pass(name, extra) { ok.push(name); console.log('  ok  ' + name + (extra ? '  ' + extra : '')); }
function bad(name, err) { fail.push(name); console.log('  FAIL  ' + name + '  ' + String(err).slice(0, 280)); }

async function json(path, opts) {
  const r = await fetch(BASE + path, opts);
  const body = await r.json().catch(() => null);
  return { status: r.status, body, headers: r.headers };
}
async function text(path) {
  const r = await fetch(BASE + path);
  return { status: r.status, type: r.headers.get('content-type') || '', body: await r.text() };
}
async function ask(body) {
  return json('/v1/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}
function replies(res) {
  return (res.body && res.body.data && res.body.data.replies) || [];
}
function graphErr(obj) {
  const e = obj && obj.error;
  if (!e) return null;
  return (e.code ? e.code + ' ' : '') + (e.message || JSON.stringify(e));
}

const SESSION = 'phone-mimic-' + Date.now();
const WA_HI = {
  object: 'whatsapp_business_account',
  entry: [{
    id: '27746667008367391',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '15552027163', phone_number_id: '1356539354199695' },
        contacts: [{ profile: { name: 'Rider' }, wa_id: '233201234567' }],
        messages: [{
          from: '233201234567',
          id: 'wamid.PHONE_MIMIC',
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'text',
          text: { body: 'hi' }
        }]
      }
    }]
  }]
};

(async () => {
  console.log('GH Fares phone mimic  ' + BASE + '\n');

  const site = await text('/');
  if (site.status === 200 && /What Ghanaians/i.test(site.body) && site.body.includes('href="/go"'))
    pass('GET /  services landing');
  else bad('GET / landing', site.status);

  const home = await text('/go');
  const waNum = (home.body.match(/whatsapp:\s*'(\d+)'/) || [])[1];
  if (home.status === 200 && waNum === '15552027163') pass('landing WA_NUMBER', waNum);
  else bad('landing WA_NUMBER', waNum || home.status);
  if (home.body.includes('intent://send?phone=') || home.body.includes('whatsapp://send?phone='))
    pass('landing WhatsApp app scheme');
  else bad('landing WhatsApp scheme', 'no app scheme');
  if (!/https?:\/\/(wa\.me|api\.whatsapp|web\.whatsapp)/i.test(home.body))
    pass('landing never opens WhatsApp website');
  else bad('landing wa.me', 'page contains website chat URL');

  const poster = await text('/go?s=kaneshie');
  if (poster.status === 200 && /Kaneshie/i.test(poster.body))
    pass('poster /?s=kaneshie  station chip');
  else bad('poster station', poster.status);

  const verify = await fetch(BASE + '/v1/webhook?hub.mode=subscribe&hub.verify_token=ghfares-verify&hub.challenge=phone-mimic');
  const challenge = await verify.text();
  if (verify.status === 200 && challenge === 'phone-mimic') pass('GET /v1/webhook  verify handshake');
  else bad('webhook verify', verify.status + ' ' + challenge.slice(0, 80));

  const unsigned = await fetch(BASE + '/v1/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(WA_HI)
  });
  if (unsigned.status === 401) pass('POST /v1/webhook  unsigned hi rejected (APP_SECRET set)');
  else if (unsigned.status === 200) bad('POST /v1/webhook unsigned', '200 — APP_SECRET missing, real Meta posts would be unsigned-ok but this is not production-safe');
  else bad('POST /v1/webhook unsigned', unsigned.status);

  const forged = await fetch(BASE + '/v1/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=deadbeef' },
    body: JSON.stringify(WA_HI)
  });
  if (forged.status === 401) pass('POST /v1/webhook  forged signature rejected');
  else bad('POST /v1/webhook forged', forged.status);

  const wa = await json('/v1/whatsapp-status');
  const d = (wa.body && wa.body.data) || {};
  if (wa.status !== 200) {
    bad('whatsapp-status', wa.status);
  } else if (d.dry_run) {
    bad('whatsapp-status', 'dry_run — WHATSAPP_TOKEN missing or DRY_RUN=true on this deploy');
  } else {
    const phoneErr = graphErr(d.phone);
    if (phoneErr) bad('Graph token / phone', phoneErr);
    else if (d.phone && d.phone.display_phone_number)
      pass('Graph token live', d.phone.display_phone_number + ' quality=' + (d.phone.quality_rating || '?'));
    else pass('whatsapp-status', 'no phone error');

    if (d.landing_number === '15552027163') pass('status landing_number', d.landing_number);
    else bad('status landing_number', d.landing_number || 'missing');

    if (d.app_id === '1048759324622035') pass('expected app Roader-Index', d.app_id);
    else if (d.app_id) pass('status app_id (older deploy)', d.app_id);
    else pass('status app_id not on this deploy yet');

    if (d.subscribed_to_app === true) pass('WABA subscribed to Roader-Index');
    else if (d.subscribed_to_app === false) bad('WABA subscribe', 'subscribed_to_app=false');
    const subErr = graphErr(d.subscribed_apps);
    if (subErr) bad('subscribed_apps', subErr);
    const names = ((d.subscribed_apps && d.subscribed_apps.data) || [])
      .map(row => (row.whatsapp_business_api_data && (row.whatsapp_business_api_data.name + ':' + row.whatsapp_business_api_data.id)) || row.id)
      .filter(Boolean);
    if (names.length) pass('WABA subscribed_apps', names.join(', '));
  }

  const cc = await json('/v1/conversational-components', { method: 'POST' });
  if (cc.status === 200 && cc.body && cc.body.success)
    pass('POST conversational-components  Meta accepted');
  else if (cc.body && cc.body.data && cc.body.data.dry_run)
    bad('conversational-components', 'dry_run');
  else bad('conversational-components', cc.status + ' ' + (graphErr(cc.body) || JSON.stringify(cc.body).slice(0, 180)));

  const welcome = await ask({ session: SESSION, type: 'request_welcome' });
  const w0 = replies(welcome)[0];
  const wids = (w0 && w0.rows || []).map(r => r.id);
  if (welcome.status === 200 && w0 && w0.type === 'list' && wids.includes('addon:fuel'))
    pass('WhatsApp request_welcome', wids.length + ' rows');
  else bad('request_welcome', JSON.stringify(w0).slice(0, 160));

  const hi = await ask({ session: SESSION + '-hi', text: 'hi' });
  const hi0 = replies(hi)[0];
  const ids = (hi0 && hi0.rows || []).map(r => r.id);
  if (hi.status === 200 && ids.includes('addon:fuel') && ids.includes('ask:road'))
    pass('phone types hi  add-on menu', ids.length + ' rows');
  else bad('hi', JSON.stringify(hi0).slice(0, 180));

  const roadQ = await ask({ session: SESSION, text: 'what is the road condition right now' });
  const road0 = JSON.stringify(replies(roadQ));
  if (roadQ.status === 200 && /road|motorway|blocked|incident|nothing reported/i.test(road0))
    pass('what is the road condition right now');
  else bad('road question', road0.slice(0, 180));

  const slashFare = await ask({ session: SESSION, text: '/fare Tema to Accra' });
  const slash0 = JSON.stringify(replies(slashFare));
  if (slashFare.status === 200 && /Tema|Accra|₵/i.test(slash0) && !/do not have/i.test(slash0))
    pass('/fare Tema to Accra');
  else bad('/fare Tema to Accra', slash0.slice(0, 180));

  const fuelTap = await ask({ session: SESSION, interactiveId: 'addon:fuel' });
  const fuel0 = replies(fuelTap)[0];
  if (fuelTap.status === 200 && fuel0)
    pass('tap Fuel watch', fuel0.type + ' ' + String(fuel0.body || '').slice(0, 80).replace(/\s+/g, ' '));
  else bad('tap Fuel watch', fuelTap.status);

  const fare = await ask({ session: SESSION, text: 'kaneshie to bubuashie' });
  const fare0 = replies(fare)[0];
  if (fare.status === 200 && /₵/.test(String(fare0 && fare0.body)) && /bubuashie|bubiashie/i.test(String(fare0 && fare0.body)))
    pass('kaneshie to bubuashie', String(fare0.body).split('\n')[0]);
  else bad('fare', String(fare0 && fare0.body).slice(0, 160));

  const loc = await ask({ session: SESSION, location: { latitude: 5.5666, longitude: -0.2354 } });
  const loc0 = replies(loc)[0];
  if (loc.status === 200 && loc0 && (loc0.type === 'list' || loc0.type === 'buttons' || /kaneshie|station|fare/i.test(String(loc0.body))))
    pass('share location (Kaneshie)', loc0.type);
  else bad('location', JSON.stringify(loc0).slice(0, 160));

  const askFare = await ask({ session: SESSION, interactiveId: 'ask:fare' });
  if (askFare.status === 200 && replies(askFare)[0])
    pass('tap Check a fare', replies(askFare)[0].type);
  else bad('tap Check a fare', askFare.status);

  const askFuel = await ask({ session: SESSION, text: 'fuel in accra' });
  const askFuel0 = replies(askFuel)[0];
  if (askFuel.status === 200 && askFuel0)
    pass('fuel in accra', String(askFuel0.body || askFuel0.type).slice(0, 90).replace(/\s+/g, ' '));
  else bad('fuel in accra', askFuel.status);

  const roads = await ask({ session: SESSION, text: 'what the current issue on tema moto way' });
  const roads0 = replies(roads)[0];
  if (roads.status === 200 && roads0)
    pass('tema motorway', String(roads0.body || roads0.type).slice(0, 90).replace(/\s+/g, ' '));
  else bad('roads', roads.status);

  const menu = await ask({ session: SESSION, interactiveId: 'menu' });
  if (menu.status === 200 && replies(menu)[0] && replies(menu)[0].type === 'list')
    pass('ice-breaker / menu tap  list');
  else bad('menu tap', replies(menu)[0] && replies(menu)[0].type);

  const addFuel = await ask({ session: SESSION, text: 'ADD FUEL' });
  if (addFuel.status === 200 && replies(addFuel).length)
    pass('ADD FUEL', replies(addFuel)[0].type);
  else bad('ADD FUEL', addFuel.status);

  const wipe = await ask({ session: SESSION, text: 'DELETE MY DATA' });
  const wipe0 = replies(wipe)[0];
  if (wipe.status === 200 && /deleted/i.test(String(wipe0 && wipe0.body)))
    pass('DELETE MY DATA');
  else bad('DELETE MY DATA', String(wipe0 && wipe0.body).slice(0, 120));

  console.log('\n' + ok.length + ' passed, ' + fail.length + ' failed');
  if (fail.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
