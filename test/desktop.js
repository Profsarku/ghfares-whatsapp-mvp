/**
 * Desktop checks — landing, chooser (no web chat URLs), QR round-trip, API.
 * Run: node test/desktop.js
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

  console.log('\n' + ok.length + ' passed, ' + fail.length + ' failed');
  if (fail.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
