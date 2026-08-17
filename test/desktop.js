/**
 * Desktop / live checks — landing, chooser, QR, API, Messenger profile, JSON body.
 * Run: node test/desktop.js
 * Live: $env:BASE='https://ghfares-whatsapp-mvp.vercel.app'; node test/desktop.js
 */
const QRCode = require('qrcode');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');

const BASE = process.env.BASE || 'http://localhost:3000';
const fail = [];
const ok = [];
function pass(name, extra) { ok.push(name); console.log('  ok  ' + name + (extra ? '  ' + extra : '')); }
function bad(name, err) { fail.push(name); console.log('  FAIL  ' + name + '  ' + err); }

async function json(path, opts) {
  const r = await fetch(BASE + path, opts);
  const body = await r.json().catch(() => null);
  return { status: r.status, body, headers: r.headers };
}
async function text(path) {
  const r = await fetch(BASE + path);
  return { status: r.status, type: r.headers.get('content-type') || '', body: await r.text() };
}

async function decodePng(buf) {
  const png = PNG.sync.read(buf);
  const code = jsQR(new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength), png.width, png.height);
  return code && code.data;
}

(async () => {
  console.log('GH Fares desktop tests  ' + BASE + '\n');

  const home = await text('/');
  if (home.status === 200 && home.body.includes('Continue with') && home.body.includes('id="goWA"') && home.body.includes('id="goFB"'))
    pass('GET /  chooser with WhatsApp and Messenger');
  else bad('GET /', 'missing chooser ' + home.status);

  if (home.body.includes('<svg') && home.body.includes('id="qr"'))
    pass('GET /  QR SVG present on the page');
  else bad('GET / QR', 'no svg in #qr');

  if (!/https?:\/\/(wa\.me|api\.whatsapp|web\.whatsapp|m\.me|messenger\.com)/i.test(home.body))
    pass('GET /  no WhatsApp/Messenger website URLs');
  else bad('GET / web urls', 'page contains wa.me or m.me');

  if (home.body.includes('whatsapp://') || home.body.includes('intent://send?phone='))
    pass('GET /  WhatsApp uses an app scheme');
  else bad('GET / WA scheme', 'no whatsapp:// or intent');

  if (home.body.includes('fb-messenger://') || home.body.includes('scheme=fb-messenger'))
    pass('GET /  Messenger uses an app scheme');
  else bad('GET / FB scheme', 'no fb-messenger scheme');

  if (home.body.includes("type: 'text/plain'"))
    pass('GET /  landing beacon is text/plain');
  else bad('GET / beacon', 'expected text/plain sendBeacon');

  const cat = await json('/v1');
  if (cat.status === 200 && cat.body.ask === 'POST /v1/ask')
    pass('GET /v1  API catalogue');
  else bad('GET /v1', JSON.stringify(cat.body));

  const hi = await json('/v1/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: 'desktop-hi', text: 'hi' })
  });
  const rows = (hi.body && hi.body.data && hi.body.data.replies && hi.body.data.replies[0] && hi.body.data.replies[0].rows) || [];
  const ids = rows.map(r => r.id);
  if (hi.status === 200 && ids.includes('addon:fuel') && ids.includes('ask:fare'))
    pass('POST /v1/ask hi  add-on menu first', ids.length + ' rows');
  else bad('POST /v1/ask hi', JSON.stringify(hi.body && hi.body.data && hi.body.data.replies));

  const fare = await json('/v1/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: 'desktop-fare', text: 'kaneshie to bubuashie' })
  });
  const fareBody = fare.body && fare.body.data && fare.body.data.replies && fare.body.data.replies[0] && fare.body.data.replies[0].body;
  if (fare.status === 200 && /bubuashie|bubiashie/i.test(String(fareBody)) && /₵/.test(String(fareBody)))
    pass('POST /v1/ask  kaneshie to bubuashie');
  else bad('POST /v1/ask fare', String(fareBody).slice(0, 180));

  const stations = await json('/v1/stations');
  if (stations.status === 200 && Array.isArray(stations.body.data) && stations.body.data.length > 10)
    pass('GET /v1/stations', stations.body.data.length + ' stations');
  else bad('GET /v1/stations', stations.status);

  const fares = await json('/v1/fares?from=kaneshie-mkt-cmplx&to=makola-tudu');
  if (fares.status === 200 && fares.body.data)
    pass('GET /v1/fares');
  else bad('GET /v1/fares', fares.status);

  const fuel = await json('/v1/fuel?area=Accra');
  if (fuel.status === 200) pass('GET /v1/fuel');
  else bad('GET /v1/fuel', fuel.status);

  const demo = await text('/demo');
  if (demo.status === 200 && demo.body.includes('GH Fares')) pass('GET /demo');
  else bad('GET /demo', demo.status);

  const qr = await text('/v1/qr');
  if (qr.status === 200 && qr.type.includes('svg') && qr.body.includes('<svg'))
    pass('GET /v1/qr  SVG');
  else bad('GET /v1/qr', qr.status + ' ' + qr.type);

  const origin = (home.body.match(/window\.__LANDING__="([^"]+)"/) || [])[1];
  if (origin) {
    const png = await QRCode.toBuffer(origin, { type: 'png', margin: 4, width: 256, errorCorrectionLevel: 'M' });
    const decoded = await decodePng(png);
    if (decoded === origin) pass('QR round-trip', decoded);
    else bad('QR round-trip', 'decoded ' + decoded + ' expected ' + origin);
    if (/^https?:\/\/(?!localhost|127\.0\.0\.1)/i.test(origin) || origin.includes('192.168.') || origin.includes('vercel.app'))
      pass('QR URL is phone-reachable', origin);
    else bad('QR URL', origin + ' looks like localhost');
  } else {
    bad('QR URL', 'no __LANDING__ on the page');
  }

  const badJson = await json('/v1/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{channel:fb}'
  });
  if (badJson.status === 400 && badJson.body && badJson.body.error === 'invalid json')
    pass('invalid JSON  returns 400');
  else bad('invalid JSON', badJson.status + ' ' + JSON.stringify(badJson.body));

  const entry = await fetch(BASE + '/v1/entry', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ channel: 'wa', source: 'desktop' })
  });
  if (entry.status === 204) pass('POST /v1/entry  text/plain');
  else bad('POST /v1/entry', entry.status);

  const hook = await fetch(BASE + '/v1/webhook/messenger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ object: 'page', entry: [] })
  });
  if (hook.status === 200) pass('POST /v1/webhook/messenger  empty page');
  else bad('POST /v1/webhook/messenger', hook.status);

  const standby = await fetch(BASE + '/v1/webhook/messenger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ object: 'page', entry: [{ id: 'PAGE', standby: [] }] })
  });
  if (standby.status === 200) pass('POST /v1/webhook/messenger  standby channel');
  else bad('POST /v1/webhook/messenger standby', standby.status);

  const want = await json('/v1/messenger-profile');
  const chips = want.body && want.body.data && want.body.data.ice_breakers
    && want.body.data.ice_breakers[0] && want.body.data.ice_breakers[0].call_to_actions;
  if (want.status === 200 && chips && chips.length === 4)
    pass('GET /v1/messenger-profile  ice breakers', chips.map(c => c.payload).join(', '));
  else bad('GET /v1/messenger-profile', want.status);

  const st = await json('/v1/messenger-status');
  if (st.status === 200 && st.body && st.body.data)
    pass('GET /v1/messenger-status', st.body.data.page && st.body.data.page.id
      ? st.body.data.page.id + ' ' + (st.body.data.page.name || '')
      : (st.body.data.dry_run ? 'dry_run' : 'ok'));
  else bad('GET /v1/messenger-status', st.status + ' ' + JSON.stringify(st.body));

  const pub = await json('/v1/messenger-profile', { method: 'POST' });
  if (pub.status === 200 && pub.body && (pub.body.result === 'success' || (pub.body.data && pub.body.data.dry_run)))
    pass('POST /v1/messenger-profile  empty body');
  else bad('POST /v1/messenger-profile', pub.status + ' ' + JSON.stringify(pub.body));

  const ice = await json('/v1/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: 'desktop-ice', interactiveId: 'menu' })
  });
  const iceType = ice.body && ice.body.data && ice.body.data.replies && ice.body.data.replies[0] && ice.body.data.replies[0].type;
  if (ice.status === 200 && iceType === 'list')
    pass('POST /v1/ask  ice-breaker payload menu');
  else bad('POST /v1/ask menu', iceType || ice.status);

  const privacy = await text('/privacy');
  if (privacy.status === 200 && /Privacy Policy/i.test(privacy.body) && /DELETE MY DATA/i.test(privacy.body))
    pass('GET /privacy');
  else bad('GET /privacy', privacy.status);

  const erased = await json('/v1/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: 'desktop-delete', text: 'DELETE MY DATA' })
  });
  const erasedBody = erased.body && erased.body.data && erased.body.data.replies && erased.body.data.replies[0] && erased.body.data.replies[0].body;
  if (erased.status === 200 && /deleted/i.test(String(erasedBody)))
    pass('POST /v1/ask  DELETE MY DATA');
  else bad('DELETE MY DATA', String(erasedBody).slice(0, 120));

  console.log('\n' + ok.length + ' passed, ' + fail.length + ' failed');
  if (fail.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
