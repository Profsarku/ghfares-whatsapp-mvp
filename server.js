const express = require('express');
const crypto = require('crypto');
const { api, classify } = require('./lib/api');
const wa = require('./lib/wa');
const caps = require('./lib/capabilities');
const engine = require('./lib/engine');
const fb = require('./lib/messenger');
const broadcast = require('./lib/broadcast');
const { ask, hashOf } = require('./lib/ask');
const qr = require('./tools/qr');
const QRCode = require('qrcode');
const fsp = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.set('trust proxy', 1);
const jsonParser = express.json({ verify: (req, res, buf) => { req.rawBody = buf; } });
app.use((req, res, next) => {
  if (req.headers['content-length'] === '0') {
    req.body = {};
    req.rawBody = Buffer.alloc(0);
    return next();
  }
  jsonParser(req, res, next);
});
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    console.error('invalid json', req.method, req.path, String(req.rawBody || '').slice(0, 200));
    return res.status(400).json({ error: 'invalid json' });
  }
  next(err);
});
app.use(express.text({ type: 'text/plain' }));

const {
  PORT = 3000,
  VERIFY_TOKEN = 'ghfares-verify',
  WHATSAPP_TOKEN = '',
  PHONE_NUMBER_ID = '',
  WHATSAPP_WABA_ID = '',
  WHATSAPP_APP_ID = '1048759324622035',
  APP_SECRET = '',
  GRAPH_VERSION = 'v21.0',
  DRY_RUN = 'true',
  FB_PAGE_TOKEN = '',
  FB_VERIFY_TOKEN = 'ghfares-verify'
} = process.env;

/* ── send ── */
async function send(payload) {
  if (DRY_RUN === 'true' || !WHATSAPP_TOKEN) {
    console.log('\n── OUTBOUND (dry run) ──\n' + JSON.stringify(payload, null, 2));
    return { dry_run: true, payload };
  }
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await res.json();
  if (!res.ok) console.error('send failed', body);
  return body;
}

/* ════════ META WEBHOOK ════════ */

app.get('/v1/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

/* Meta retries a webhook if we take more than a few seconds to 200.
   Remember message ids so a retry does not send the same reply twice. */
const recentWaIds = new Map();
function waAlreadyHandled(id) {
  if (!id) return false;
  const now = Date.now();
  if (recentWaIds.has(id)) return true;
  recentWaIds.set(id, now);
  if (recentWaIds.size > 500) {
    for (const [k, t] of recentWaIds) if (now - t > 15 * 60 * 1000) recentWaIds.delete(k);
  }
  return false;
}

app.post('/v1/webhook', async (req, res) => {
  // Signature check — Meta signs every payload; reject anything unsigned in prod.
  // APP_SECRET must be from Roader-Index (1048759324622035).
  if (APP_SECRET) {
    const sig = req.get('x-hub-signature-256') || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody || Buffer.from('')).digest('hex');
    if (sig !== expected) {
      console.error('whatsapp webhook bad signature');
      return res.sendStatus(401);
    }
  }

  const entry = req.body.entry?.[0]?.changes?.[0]?.value;
  const msg = entry?.messages?.[0];
  if (!msg) {
    console.log('whatsapp webhook hit', { object: req.body && req.body.object, has_message: false });
    return res.sendStatus(200);
  }
  if (waAlreadyHandled(msg.id)) {
    console.log('whatsapp duplicate skipped', { id: msg.id, type: msg.type });
    return res.sendStatus(200);
  }

  try {
    console.log('whatsapp in', { from: msg.from, type: msg.type });

    const from = msg.from;
    let text = null, interactiveId = null, location = null, type = null;

    if (msg.type === 'request_welcome') type = 'request_welcome';
    if (msg.type === 'text') text = msg.text.body;
    if (msg.type === 'location') location = { latitude: msg.location.latitude, longitude: msg.location.longitude };
    if (msg.type === 'interactive') {
      const i = msg.interactive;
      if (i.type === 'button_reply') interactiveId = i.button_reply.id;
      if (i.type === 'list_reply') interactiveId = i.list_reply.id;
      if (i.type === 'nfm_reply') {
        const data = JSON.parse(i.nfm_reply.response_json || '{}');
        if (Array.isArray(data.addons)) {
          const hash = hashOf(from);
          data.addons.forEach(id => caps.add(hash, id));
          const names = data.addons.map(id => caps.byId[id]?.title).filter(Boolean).join(', ');
          await send(require('./lib/wa').text(from, `Added: *${names}*.\n\nSend MY ADDONS any time to see or change them.`));
          return res.sendStatus(200);
        }
        text = data.text || 'menu';
      }
    }

    const out = ask({ from, text, interactiveId, location, type });
    for (const r of out.payloads) await send(r);
  } catch (e) {
    console.error('webhook error', e);
  }
  res.sendStatus(200);
});

/* ════════ ENTRY POINT ════════
   One link, one QR. Visitor chooses WhatsApp or Messenger and lands in the
   phone app. Attribution is aggregate — views counted here, new
   conversations counted at the webhook, never linked per person. */

const entryLog = [];
const SITE = process.env.SITE_URL || 'https://ghfares.com';

function lanIp() {
  const skip = /virtual|vmware|vbox|hyper-v|loopback|docker|wsl|vethernet/i;
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const a of addrs || []) {
      if (a.internal) continue;
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      found.push(a.address);
    }
  }
  return found.find(ip => ip.startsWith('192.168.'))
    || found.find(ip => ip.startsWith('10.'))
    || found.find(ip => /^172\.(1[6-9]|2\d|3[01])\./.test(ip))
    || found[0]
    || null;
}

/* Phone-reachable URL for the chooser. localhost is useless in a camera. */
function shareOrigin(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const host = String(req.get('host') || `localhost:${PORT}`);
  const hostname = host.replace(/^\[/, '').replace(/\]:\d+$/, '').replace(/:\d+$/, '');
  const port = /]:(\d+)$/.test(host) ? host.match(/]:(\d+)$/)[1]
    : (host.includes(':') && !host.startsWith('[') ? host.split(':').pop() : PORT);
  if (/^(localhost|127\.0\.0\.1|::1)$/i.test(hostname)) {
    const ip = lanIp();
    if (ip) return `http://${ip}:${port}`;
  }
  return `${req.protocol}://${host}`;
}

function qrSvg(url) {
  return QRCode.toString(url, {
    type: 'svg',
    margin: 4,
    width: 168,
    errorCorrectionLevel: 'M',
    color: { dark: '#14181c', light: '#ffffff' }
  });
}

async function landing(req, res) {
  const station = String(req.query.s || '').replace(/[^a-z0-9-]/gi, '');
  const origin = shareOrigin(req);
  const url = station ? `${origin}/go?s=${station}` : `${origin}/go`;
  let page = fsp.readFileSync(path.join(__dirname, 'public', 'go.html'), 'utf8');
  const svg = await qrSvg(url);

  const inject = `<script>window.__LANDING__=${JSON.stringify(url)};</script>`;
  page = page.replace('</head>', inject + '</head>');
  page = page.replace('<div class="qr" id="qr"></div>', `<div class="qr" id="qr">${svg}</div>`);
  page = page.replace(
    "whatsapp: '233200000000',",
    `whatsapp: '${process.env.WA_NUMBER || '233200000000'}',`
  ).replace(
    "messenger: 'ghfares',",
    `messenger: '${process.env.FB_PAGE_USERNAME || 'ghfares'}',`
  ).replace(
    "pageId: '',",
    `pageId: '${process.env.FB_PAGE_ID || ''}',`
  );

  entryLog.push({ type: 'view', station: station || null, at: new Date().toISOString() });
  res.set('Cache-Control', 'no-store').send(page);
}
function sendPublic(res, file, type) {
  if (type) res.type(type);
  res.sendFile(path.join(__dirname, 'public', file));
}

app.get('/', (req, res) => {
  if (req.query.s) return landing(req, res);
  sendPublic(res, 'index.html', 'html');
});
app.get('/go', landing);
app.get('/support', (req, res) => sendPublic(res, 'support.html', 'html'));
app.get('/site.css', (req, res) => sendPublic(res, 'site.css', 'css'));
app.get('/site.js', (req, res) => sendPublic(res, 'site.js', 'javascript'));

/* Channel chosen — beacon from the landing page. Aggregate only. */
app.post('/v1/entry', (req, res) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { channel, station, source } = body || {};
  entryLog.push({ type: 'choose', channel, station: station || null, source: source || null,
                  at: new Date().toISOString() });
  res.sendStatus(204);
  if (channel === 'fb' || channel === 'messenger') publishMessengerProfile().catch(() => {});
});

/* Scan-to-choice funnel, per station. */
app.get('/v1/entry/stats', (req, res) => {
  const by = {};
  for (const e of entryLog) {
    const k = e.station || '(direct)';
    by[k] = by[k] || { views: 0, whatsapp: 0, messenger: 0 };
    if (e.type === 'view') by[k].views++;
    if (e.type === 'choose') by[k][e.channel === 'wa' ? 'whatsapp' : 'messenger']++;
  }
  const totals = Object.values(by).reduce((a, v) =>
    ({ views: a.views + v.views, whatsapp: a.whatsapp + v.whatsapp, messenger: a.messenger + v.messenger }),
    { views: 0, whatsapp: 0, messenger: 0 });
  res.json(envelope({ by_station: by, totals,
    choice_rate: totals.views ? Math.round((totals.whatsapp + totals.messenger) / totals.views * 100) + '%' : '—' },
    { note: 'Aggregate only — no link between a scan and a conversation.' }));
});

/* Printable QR for the WhatsApp / Messenger chooser. */
app.get('/v1/qr', async (req, res) => {
  const url = `${shareOrigin(req)}/`;
  const svg = await qrSvg(url);
  res.type('image/svg+xml').send(svg);
});

/* ════════ MESSENGER WEBHOOK ════════
   Same router, same add-ons, same data. Only the rendering differs. */

async function graph(path, { method = 'GET', body } = {}) {
  if (!FB_PAGE_TOKEN) return { error: { message: 'FB_PAGE_TOKEN missing' } };
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://graph.facebook.com/${GRAPH_VERSION}${path}${sep}access_token=${encodeURIComponent(FB_PAGE_TOKEN)}`;
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return r.json();
}

const MESSENGER_WEBHOOK_FIELDS = 'messages,messaging_postbacks,messaging_optins,messaging_referrals,standby,messaging_handovers';

async function subscribePage() {
  return graph(`/me/subscribed_apps?subscribed_fields=${MESSENGER_WEBHOOK_FIELDS}`, { method: 'POST' });
}

async function takeThread(psid) {
  if (DRY_RUN === 'true' || !FB_PAGE_TOKEN) return { dry_run: true };
  const taken = await graph('/me/take_thread_control', {
    method: 'POST',
    body: { recipient: { id: psid }, metadata: 'GH Fares' }
  });
  if (taken && taken.error) {
    const asked = await graph('/me/request_thread_control', {
      method: 'POST',
      body: { recipient: { id: psid }, metadata: 'GH Fares' }
    });
    if (asked && asked.error) console.error('messenger thread control failed', taken, asked);
    return asked;
  }
  return taken;
}

async function sendFB(payload) {
  if (DRY_RUN === 'true' || !FB_PAGE_TOKEN) {
    console.log('\n── MESSENGER OUT (dry run) ──\n' + JSON.stringify(payload, null, 2));
    return { dry_run: true, payload };
  }
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/me/messages?access_token=${FB_PAGE_TOKEN}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const body = await res.json();
  if (!res.ok) console.error('messenger send failed', body);
  return body;
}

app.get('/v1/webhook/messenger', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === FB_VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

async function handleMessengerEvent(ev) {
  if (ev.message && ev.message.is_echo) return;
  const psid = ev.sender && ev.sender.id;
  if (!psid) return;
  const hash = hashOf('fb:' + psid);
  let text = null, interactiveId = null, location = null, type = null;

  if (ev.postback) {
    interactiveId = ev.postback.payload;
    const ref = ev.postback.referral && ev.postback.referral.ref;
    const stn = ref && (ref.match(/stn-([a-z0-9-]+)/) || [])[1];
    if (stn) caps.subscriber(hash).station = stn;
    if (interactiveId === 'menu' && !caps.subscriber(hash).onboarded) type = 'request_welcome';
  }
  if (ev.message) {
    if (ev.message.quick_reply) interactiveId = ev.message.quick_reply.payload;
    else if (ev.message.text) text = ev.message.text;
    const att = (ev.message.attachments || []).find(a => a.type === 'location');
    if (att) location = { latitude: att.payload.coordinates.lat, longitude: att.payload.coordinates.long };
  }
  if (!text && !interactiveId && !location && !type) return;

  console.log('messenger in', { psid, text, interactiveId, type });
  await takeThread(psid);
  const out = ask({ from: psid, hash, text, interactiveId, location, type });
  for (const r of out.payloads) {
    for (const m of fb.fromWhatsApp(r, psid)) {
      const sent = await sendFB(m);
      if (sent && sent.error) console.error('messenger send failed', sent);
    }
  }
}

app.post('/v1/webhook/messenger', async (req, res) => {
  try {
    const entries = (req.body && req.body.entry) || [];
    console.log('messenger webhook hit', {
      object: req.body && req.body.object,
      entries: entries.length,
      keys: entries.map(e => Object.keys(e || {}))
    });
    for (const entry of entries) {
      const events = [...(entry.messaging || []), ...(entry.standby || [])];
      for (const ev of events) await handleMessengerEvent(ev);
    }
  } catch (e) { console.error('messenger webhook error', e); }
  res.sendStatus(200);
});

/* Ice breakers + greeting + Get Started + persistent menu on the Page.
   The landing redirect cannot draw these — only Graph /me/messenger_profile. */
let lastProfilePublish = 0;
async function publishMessengerProfile(force) {
  const body = fb.messengerProfile();
  if (DRY_RUN === 'true' || !FB_PAGE_TOKEN) return { dry_run: true, body };
  if (!force && Date.now() - lastProfilePublish < 10 * 60 * 1000) {
    return { skipped: true, reason: 'rate_limit_window' };
  }
  lastProfilePublish = Date.now();
  const json = await graph('/me/messenger_profile', { method: 'POST', body });
  if (json && json.error) console.error('messenger profile publish failed', json);
  else console.log('messenger profile published', json);
  const subscribed = await subscribePage();
  if (subscribed && subscribed.error) console.error('messenger page subscribe failed', subscribed);
  else console.log('messenger page subscribed', subscribed);
  json.subscribed = subscribed;
  return json;
}

app.get('/v1/messenger-profile', (req, res) =>
  res.json(envelope(fb.messengerProfile(), { note: 'POST this body to Graph /me/messenger_profile. Widgets appear on a new Page thread, not on the website.' })));

app.post('/v1/messenger-profile', async (req, res) => {
  const json = await publishMessengerProfile(true);
  const ok = json && (json.result === 'success' || json.dry_run);
  res.status(ok ? 200 : 400).json(json.dry_run ? envelope(json) : json);
});

/* What Meta actually has for this Page — no token in the response. */
app.get('/v1/messenger-status', async (req, res) => {
  if (DRY_RUN === 'true' || !FB_PAGE_TOKEN) {
    return res.json(envelope({ dry_run: true, page: null, subscribed_apps: [], live_profile: null }));
  }
  const [page, subscribed_apps, live_profile, conversations] = await Promise.all([
    graph('/me?fields=id,name,category,username,link,fan_count'),
    graph('/me/subscribed_apps'),
    graph('/me/messenger_profile?fields=get_started,greeting,ice_breakers,persistent_menu'),
    graph('/me/conversations?fields=updated_time&limit=5')
  ]);
  const threads = (conversations && conversations.data) || [];
  res.json(envelope({
    page,
    subscribed_apps,
    live_profile,
    expected_fields: MESSENGER_WEBHOOK_FIELDS.split(','),
    inbox: {
      thread_count: threads.length,
      latest: threads[0] && threads[0].updated_time,
      error: conversations && conversations.error
    }
  }));
});

/* ════════ PUBLIC API ════════ */

const envelope = (data, meta = {}) => ({ data, meta: { as_of: api.core.updated, ...meta } });

app.get('/v1/stations', (req, res) =>
  res.json(envelope(api.core.stations.map(s => ({ id: s.id, name: s.name, region: s.region, branch: s.branch })), { source: 'published' })));

app.get('/v1/stations/near', (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });
  res.json(envelope(api.stationsNear(parseFloat(lat), parseFloat(lng))));
});

app.get('/v1/stations/:id/fares', (req, res) => {
  const r = api.stationFares(req.params.id);
  if (!r) return res.status(404).json({ error: 'station not found' });
  res.json(envelope(r, { source: r.source, authority: r.authority }));
});

app.get('/v1/fares', (req, res) => {
  const r = api.fare(req.query.from, req.query.to);
  if (!r) return res.status(404).json({ error: 'pair not mapped', queued: true });
  res.json(envelope(r, { source: r.source, authority: r.authority }));
});

app.get('/v1/fuel', (req, res) => {
  const r = api.fuel(req.query.area);
  res.json(envelope(r, { source: r.source, authority: r.authority }));
});

app.get('/v1/fuel/compare', (req, res) => {
  const [a, b] = String(req.query.areas || '').split(',');
  const r = api.fuelCompare(a, b);
  if (!r) return res.status(404).json({ error: 'area not loaded' });
  res.json(envelope(r, { source: r.source, authority: r.authority }));
});

app.get('/v1/incidents', (req, res) => {
  const r = api.incidents(req.query.road);
  res.json(envelope(r, { source: r.source, authority: r.authority }));
});

app.post('/v1/reports/fare', (req, res) => {
  const { station, dest, amount } = req.body;
  const r = api.reportFare(station, dest, Number(amount));
  if (!r) return res.status(400).json({ error: 'unknown station or destination' });
  res.status(201).json(envelope(r, { source: 'crowd' }));
});

app.post('/v1/reports/queue', (req, res) => {
  const { station, dest, state } = req.body;
  if (!['moving', 'slow', 'stuck'].includes(state)) return res.status(400).json({ error: 'bad state' });
  res.status(201).json(envelope(api.reportQueue(station, dest, state), { source: 'crowd' }));
});

/* ════════ BROADCAST ════════
   Plan first, send second. The plan shows who is excluded and why, so a
   broadcast is never a surprise. */

const TEMPLATES = {
  fuel_price_change:   { capability: 'fuel',  category: 'utility' },
  road_incident:       { capability: 'roads', category: 'utility' },
  queue_state_change:  { capability: 'queue', category: 'utility' },
  fare_chart_revision: { capability: 'chart', category: 'utility' }
};

app.get('/v1/broadcasts/segments', (req, res) => res.json(envelope({
  by_capability: caps.CAPABILITIES.map(c => ({
    capability: c.id, keyword: c.keyword, opted_in: caps.audience(c.id).length, proactive: c.proactive
  })),
  templates: Object.entries(TEMPLATES).map(([name, t]) => ({ name, ...t })),
  config: broadcast.CONFIG
})));

/* Dry run by default — pass ?send=true to emit payloads. */
app.post('/v1/broadcasts', (req, res) => {
  const { template, params = [], segment = null } = req.body;
  const t = TEMPLATES[template];
  if (!t) return res.status(400).json({ error: 'unknown template', known: Object.keys(TEMPLATES) });

  const planned = broadcast.plan({ capability: t.capability, template, params, segment, category: t.category });
  if (req.query.send !== 'true') {
    return res.json(envelope({ ...planned, recipients: undefined, dry_run: true },
      { note: 'Add ?send=true to execute' }));
  }
  const result = broadcast.execute(planned, hash =>
    wa.template(hash, template, 'en', params));
  res.status(202).json(envelope({ plan: { ...planned, recipients: undefined }, result }));
});

app.get('/v1/broadcasts/ledger/:hash?', (req, res) =>
  res.json(envelope(broadcast.ledger(req.params.hash))));

/* add-ons over HTTP, same registry the bot uses */
app.get('/v1/capabilities', (req, res) => res.json(envelope(caps.CAPABILITIES)));
app.get('/v1/subscribers/:hash/capabilities', (req, res) => res.json(envelope(caps.list(req.params.hash))));
app.post('/v1/subscribers/:hash/capabilities', (req, res) => {
  const c = caps.add(req.params.hash, req.body.capability);
  if (!c) return res.status(404).json({ error: 'no such capability' });
  res.status(201).json(envelope(c));
});
app.delete('/v1/subscribers/:hash/capabilities/:id', (req, res) => {
  caps.remove(req.params.hash, req.params.id);
  res.sendStatus(204);
});

/* Conversational Components — Meta's native widgets.
   GET returns the config; POST pushes it to the phone number. */
app.get('/v1/conversational-components', (req, res) =>
  res.json(envelope(engine.conversationalAutomationConfig(), { note: 'PATCH this to /{phone-number-id}/conversational_automation' })));

async function waGraph(path, { method = 'GET', body } = {}) {
  if (!WHATSAPP_TOKEN) return { error: { message: 'WHATSAPP_TOKEN missing' } };
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://graph.facebook.com/${GRAPH_VERSION}${path}${sep}access_token=${encodeURIComponent(WHATSAPP_TOKEN)}`;
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return r.json();
}

function subscribedAppIds(payload) {
  return ((payload && payload.data) || []).map(row =>
    (row.whatsapp_business_api_data && row.whatsapp_business_api_data.id) || row.id
  ).filter(Boolean);
}

async function subscribeWhatsApp() {
  let waba = WHATSAPP_WABA_ID;
  if (!waba && PHONE_NUMBER_ID) {
    const phone = await waGraph(`/${PHONE_NUMBER_ID}?fields=id,display_phone_number,verified_name,quality_rating`);
    waba = phone && phone.whatsapp_business_account && phone.whatsapp_business_account.id;
  }
  if (!waba) return { error: { message: 'WHATSAPP_WABA_ID missing' } };
  const posted = await waGraph(`/${waba}/subscribed_apps`, { method: 'POST' });
  const listed = await waGraph(`/${waba}/subscribed_apps`);
  const apps = subscribedAppIds(listed);
  return {
    ...posted,
    app_id: WHATSAPP_APP_ID,
    subscribed_apps: listed,
    subscribed_to_app: apps.includes(WHATSAPP_APP_ID)
  };
}

app.post('/v1/conversational-components', async (req, res) => {
  const body = engine.conversationalAutomationConfig();
  if (DRY_RUN === 'true' || !WHATSAPP_TOKEN) return res.json(envelope({ dry_run: true, body }));
  const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/conversational_automation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await r.json();
  const subscribed = await subscribeWhatsApp();
  if (subscribed && subscribed.error) console.error('whatsapp waba subscribe failed', subscribed);
  else console.log('whatsapp waba subscribed', subscribed);
  json.subscribed = subscribed;
  res.status(r.ok ? 200 : 400).json(json);
});

/* Phone number + WABA subscription — no token in the response. */
app.get('/v1/whatsapp-status', async (req, res) => {
  if (DRY_RUN === 'true' || !WHATSAPP_TOKEN) {
    return res.json(envelope({
      dry_run: true,
      phone: null,
      waba: WHATSAPP_WABA_ID || null,
      app_id: WHATSAPP_APP_ID
    }));
  }
  const phone = PHONE_NUMBER_ID
    ? await waGraph(`/${PHONE_NUMBER_ID}?fields=id,display_phone_number,verified_name,quality_rating`)
    : { error: { message: 'PHONE_NUMBER_ID missing' } };
  const wabaId = WHATSAPP_WABA_ID || null;
  const subscribed_apps = wabaId ? await waGraph(`/${wabaId}/subscribed_apps`) : { error: { message: 'WABA id unknown' } };
  const apps = subscribedAppIds(subscribed_apps);
  res.json(envelope({
    phone,
    waba_id: wabaId || null,
    app_id: WHATSAPP_APP_ID,
    subscribed_to_app: apps.includes(WHATSAPP_APP_ID),
    subscribed_apps,
    landing_number: process.env.WA_NUMBER || null
  }));
});

app.post('/v1/nlu/classify', (req, res) => res.json(envelope(classify(req.body.text))));

app.get('/v1/health/freshness', (req, res) => res.json(envelope({
  charts: api.charts(),
  fuel_window: api.core.fuel.window,
  live_incidents: api.core.incidents.filter(i => i.status === 'live').length,
  subscribers: caps.subscribers.size
})));

/* ════════ DEMO PHONE ════════
   The sample WhatsApp / Messenger / website UI talks to the live engine
   through these endpoints. No Meta account required. */

const DEMO_STATIONS = [
  { id: 'kaneshie-mkt-cmplx', slug: 'kaneshie', label: 'Kaneshie Market Station' },
  { id: 'abeka-lapaz', slug: 'abeka-lapaz', label: 'Abeka Lapaz' },
  { id: 'nima-overhead-station', slug: 'nima', label: 'Nima Overhead Station' },
  { id: 'achimota-station', slug: 'achimota', label: 'Achimota Station' },
  { id: 'circle-odorna-station', slug: 'circle', label: 'Circle Odorna Station' },
  { id: 'accra-new-tema-station', slug: 'tema', label: 'Accra New Tema Station' },
  { id: '_', slug: '', label: 'Direct link' }
];

app.get('/v1', (req, res) => res.json({
  name: 'GH Fares',
  audience: 'riders, researchers, and institutions',
  landing: '/',
  ask: 'POST /v1/ask',
  endpoints: {
    ask: 'POST /v1/ask  { session?, text?, interactive_id?, location? }',
    stations: 'GET /v1/stations',
    stations_near: 'GET /v1/stations/near?lat=&lng=',
    station_fares: 'GET /v1/stations/:id/fares',
    fares: 'GET /v1/fares?from=&to=',
    fuel: 'GET /v1/fuel?area=',
    fuel_compare: 'GET /v1/fuel/compare?areas=Accra,Tema',
    incidents: 'GET /v1/incidents?road=',
    report_fare: 'POST /v1/reports/fare',
    report_queue: 'POST /v1/reports/queue',
    classify: 'POST /v1/nlu/classify',
    capabilities: 'GET /v1/capabilities',
    freshness: 'GET /v1/health/freshness'
  }
}));

/* Everyone — riders included — talks to the engine here. */
app.post('/v1/ask', (req, res) => {
  const { session, text, interactive_id, interactiveId, location, type } = req.body || {};
  const out = ask({ session, text, interactiveId: interactive_id || interactiveId, location, type });
  res.json(envelope({
    session: out.session,
    intent: out.intent,
    places: out.places,
    replies: out.replies,
    subscriber: out.subscriber
  }, { via: out.via }));
});
app.get(['/favicon.svg', '/favicon.ico', '/favicon.png'], (req, res) => {
  res.type('image/svg+xml').sendFile(path.join(__dirname, 'public', 'favicon.svg'));
});

app.get(['/privacy', '/privacy-policy', '/data-deletion'], (req, res) =>
  res.type('html').sendFile(path.join(__dirname, 'public', 'privacy.html')));

app.get('/demo', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'demo.html')));
app.get('/demo.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'demo.js')));

app.get('/v1/demo/bootstrap', (req, res) => {
  const qrs = {};
  for (const s of DEMO_STATIONS) {
    const url = `${SITE}/go` + (s.slug ? `?s=${s.slug}` : '');
    qrs[s.id] = { label: s.label, slug: s.slug, m: qr.matrix(url) };
  }
  res.json({
    ice_breakers: engine.ICE_BREAKERS,
    commands: engine.COMMANDS,
    messenger_profile: fb.messengerProfile(),
    qrs
  });
});

app.post('/v1/demo/turn', (req, res) => {
  const { session = 'wa-preview-01', text, interactiveId, location, type, channel } = req.body || {};
  const from = channel === 'fb' ? 'PSID' : '233201234567';
  const out = ask({ session, from, hash: String(session), text, interactiveId, location, type });
  const messenger = out.payloads.flatMap(r => fb.fromWhatsApp(r, from));
  res.json({ replies: out.payloads, messenger });
});

app.post('/v1/demo/reset', (req, res) => {
  const session = String((req.body || {}).session || '');
  if (session) caps.subscribers.delete(session);
  res.sendStatus(204);
});

app.post('/v1/demo/station', (req, res) => {
  const { session = 'wa-preview-01', station } = req.body || {};
  caps.subscriber(String(session)).station = station || null;
  res.json({ station: caps.subscriber(String(session)).station });
});

if (require.main === module) {
  const ip = lanIp();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`GH Fares  landing http://localhost:${PORT}` + (ip ? `  phone http://${ip}:${PORT}` : '') + `  (DRY_RUN=${DRY_RUN})`);
  });
}
module.exports = app;
