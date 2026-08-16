/**
 * Runs conversations through the real engine and prints both the
 * human-readable reply and the exact JSON that would be POSTed to Meta.
 *
 *   node test/demo.js          full walkthrough
 *   node test/demo.js --json   include full payloads
 */
const engine = require('../lib/engine');
const caps = require('../lib/capabilities');
const bc = require('../lib/broadcast');   // wires the consent hook — must load before any ADD
const wa = require('../lib/wa');

const SHOW_JSON = process.argv.includes('--json');
const FROM = '233201234567';
const HASH = 'demo-subscriber-01';

const C = { d: '\x1b[2m', b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m', r: '\x1b[0m' };

function render(p) {
  const i = p.interactive;
  if (p.type === 'text') return p.text.body;
  if (p.type === 'template') return `[TEMPLATE ${p.template.name}] ${p.template.components?.[0]?.parameters.map(x => x.text).join(' · ') || ''}`;
  if (i?.type === 'button')
    return i.body.text + '\n' + i.action.buttons.map(b => `   [ ${b.reply.title} ]`).join('');
  if (i?.type === 'list')
    return i.body.text + '\n   ▾ ' + i.action.button + '\n' +
      i.action.sections.flatMap(s => s.rows.map(r => `     • ${r.title}${r.description ? '\n       ' + r.description : ''}`)).join('\n');
  if (i?.type === 'location_request_message') return i.body.text + '\n   [ 📍 Send location ]';
  if (i?.type === 'flow') return i.body.text + `\n   [ ${i.action.parameters.flow_cta} ] (Flow ${i.action.parameters.flow_id})`;
  return JSON.stringify(p);
}

function turn(label, input) {
  console.log(`\n${C.c}▸ ${label}${C.r}`);
  const replies = engine.handle({ from: FROM, hash: HASH, ...input });
  replies.forEach(p => {
    console.log(`${C.g}◂${C.r} ` + render(p).split('\n').join('\n  '));
    if (SHOW_JSON) console.log(C.d + JSON.stringify(p, null, 2) + C.r);
  });
  return replies;
}

console.log(`${C.b}═══ GH FARES — WHATSAPP MVP WALKTHROUGH ═══${C.r}`);

console.log(`\n${C.y}── 1 · Cold start ──${C.r}`);
turn('hi', { text: 'hi' });

console.log(`\n${C.y}── 2 · Location share → every fare from the station ──${C.r}`);
turn('📍 shares location (Kaneshie)', { location: { latitude: 5.5666, longitude: -0.2354 } });

console.log(`\n${C.y}── 3 · Akosua: Kaneshie → Bubuashie ──${C.r}`);
turn('kaneshie to bubiashie', { text: 'kaneshie to bubiashie' });

console.log(`\n${C.y}── 4 · Who has the lowest fare ──${C.r}`);
turn('cheapest from kaneshie', { text: 'cheapest from kaneshie' });

console.log(`\n${C.y}── 5 · THE ADD-ONS ──${C.r}`);
turn('ADD', { text: 'add' });
turn('ADD FUEL', { text: 'add fuel' });
turn('ADD ROADS', { text: 'add roads' });
turn('ADD MY ROUTE', { text: 'add my route' });
turn('nima to circle   (saves it as the default route)', { text: 'nima to circle' });
turn('MY ADDONS', { text: 'my addons' });

console.log(`\n${C.y}── 6 · What the route add-on changes ──${C.r}`);
turn('how much', { text: 'how much' });

console.log(`\n${C.y}── 7 · Quick report add-on: a bare number is enough ──${C.r}`);
turn('ADD REPORT', { text: 'add report' });
turn('10', { text: '10' });

console.log(`\n${C.y}── 8 · Fuel: "in my area" and a comparison ──${C.r}`);
turn('get me all fuel pricing in my area', { text: 'get me all fuel pricing in my area' });
turn('price of fuel in accra compared to tema', { text: 'what is the price of fuel in accra compared to tema' });

console.log(`\n${C.y}── 9 · Road state ──${C.r}`);
turn('what the current issue on tema moto way', { text: 'what the current issue on tema moto way' });

console.log(`\n${C.y}── 10 · Report a fare from a tap ──${C.r}`);
turn('[tap] Report what I paid', { interactiveId: 'report:kaneshie-mkt-cmplx:bubiashie-station' });
turn('9', { text: '9' });

console.log(`\n${C.y}── 11 · Queue reporting, one tap ──${C.r}`);
turn('[tap] Report the queue', { interactiveId: 'queue:kaneshie-mkt-cmplx:bubiashie-station' });
turn('[tap] 🔴 Stuck', { interactiveId: 'queue:kaneshie-mkt-cmplx:bubiashie-station:stuck' });

console.log(`\n${C.y}── 12 · Proactive push (needs an approved template) ──${C.r}`);
const pushes = [
  ...engine.pushFuelAlert('Star Oil Lapaz', 'Accra', 15.20, 15.05),
  ...engine.pushRoadAlert('Tema Motorway', 'Crash — two lanes blocked', '25–40 min'),
  ...engine.pushChartRevision('GPRTU', '2 Sep 2026', 'Kaneshie → Bubiashie', '6.00', '7.20')
];
pushes.forEach(p => {
  console.log(`${C.g}◂${C.r} ` + render(p));
  if (SHOW_JSON) console.log(C.d + JSON.stringify(p, null, 2) + C.r);
});

console.log(`\n${C.y}── 13 · Removing an add-on ──${C.r}`);
turn('REMOVE FUEL', { text: 'remove fuel' });
turn('MY ADDONS', { text: 'my addons' });

/* ── 14 · BROADCASTING ── */
console.log(`\n${C.y}── 14 · BROADCASTING ──${C.r}`);

// three more riders opt in, so there is an audience to broadcast to
['rider-kwame', 'rider-akosua', 'rider-yaw'].forEach(h => {
  engine.handle({ from: h, hash: h, text: 'add roads' });
});
engine.handle({ from: 'rider-yaw', hash: 'rider-yaw', text: 'add fuel' });

console.log(`\n${C.c}▸ Consent ledger — written by ADD, not bolted on${C.r}`);
console.log(bc.optIns.map(o =>
  `${C.d}  ${o.at.slice(11, 19)}  ${(o.hash + '                ').slice(0, 16)} ${(o.capability + '        ').slice(0, 8)} via ${o.method}${C.r}`
).join('\n'));

console.log(`\n${C.c}▸ Segments — who can legally be messaged${C.r}`);
caps.CAPABILITIES.forEach(c => {
  const n = caps.audience(c.id).length;
  if (n) console.log(`${C.d}  ${(c.title + '                 ').slice(0, 18)} ${n} opted in${C.r}`);
});

console.log(`\n${C.c}▸ DRY RUN — plan a road alert before sending anything${C.r}`);
const planned = bc.plan({
  capability: 'roads',
  template: 'road_incident',
  params: ['Tema Motorway', 'Crash — two lanes blocked', '25–40 min']
});
console.log(JSON.stringify({
  eligible: planned.eligible,
  excluded: planned.excluded,
  excluded_reasons: planned.excluded_reasons,
  tier: planned.tier,
  tier_limit: planned.tier_limit,
  batches: planned.batches,
  quiet_hours_block: planned.quiet_hours_block,
  estimated_messages: planned.estimated_messages,
  note: planned.note
}, null, 2).split('\n').map(l => '  ' + l).join('\n'));

console.log(`\n${C.c}▸ EXECUTE${C.r}`);
const result = bc.execute(planned, h => wa.template(h, 'road_incident', 'en',
  ['Tema Motorway', 'Crash — two lanes blocked', '25–40 min']));
console.log(`${C.g}  sent ${result.sent}, held ${result.held}${C.r}`);
if (result.payloads && result.payloads[0]) {
  console.log(`${C.d}  one payload:${C.r}`);
  console.log(JSON.stringify(result.payloads[0], null, 2).split('\n').map(l => '    ' + l).join('\n'));
}

console.log(`\n${C.c}▸ Targeted segment — only riders whose saved route uses Circle${C.r}`);
const targeted = bc.plan({
  capability: 'roads', template: 'road_incident',
  segment: { type: 'station', args: ['circle'] }
});
console.log(`${C.d}  audience ${targeted.audience_total} of ${caps.audience('roads').length} roads subscribers${C.r}`);

console.log(`\n${C.c}▸ Frequency cap — our rule, not Meta's${C.r}`);
for (let i = 0; i < 3; i++) {
  const p = bc.plan({ capability: 'roads', template: 'road_incident' });
  const r = bc.execute(p, h => ({ to: h }));
  console.log(`${C.d}  attempt ${i + 2}: eligible ${p.eligible}, sent ${r.sent}` +
    (Object.keys(p.excluded_reasons).length ? `, blocked by ${Object.keys(p.excluded_reasons).join(', ')}` : '') + C.r);
}

console.log(`\n${C.c}▸ Audit trail for one subscriber${C.r}`);
console.log(JSON.stringify(bc.ledger('rider-yaw'), null, 2).split('\n').map(l => '  ' + l).join('\n'));

const s = caps.subscriber(HASH);
console.log(`\n${C.b}═══ SUBSCRIBER STATE ═══${C.r}`);
console.log(JSON.stringify({ hash: s.hash, capabilities: [...s.caps], route: s.route, station: s.station }, null, 2));
