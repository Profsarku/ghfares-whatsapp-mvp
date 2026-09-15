const wa = require('./wa');
const caps = require('./capabilities');
const { classify, api } = require('./api');

const money = n => `₵${Number(n).toFixed(2).replace(/\.00$/, '')}`;
const DOT = { moving: '🟢', slow: '🟡', stuck: '🔴' };

/** Provenance line — appended to every substantive answer. */
function prov(r) {
  if (!r) return '';
  if (r.source === 'published') return `\n\n_${r.authority} · published data_`;
  if (r.source === 'survey') return `\n\n_${r.authority}_`;
  if (r.source === 'crowd') return `\n\n_${r.authority} · accuracy grows with reports_`;
  return `\n\n_${r.authority}_`;
}

function clip(s, n) {
  const t = String(s || '').trim();
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

function listSections(rows, title, size = 9) {
  const out = [];
  for (let i = 0; i < rows.length && out.length < 10; i += size) {
    const slice = rows.slice(i, i + size);
    out.push({
      title: clip(i === 0 ? title : `More ${i + 1}–${i + slice.length}`, 24),
      rows: slice
    });
  }
  return out.length ? out : [{ title: clip(title, 24), rows: [] }];
}

/* ══════════════ ADD-ONS ══════════════ */

function addonMenu(to, hash) {
  const rows = caps.list(hash).map(c => ({
    id: `addon:${c.id}`,
    title: `${c.active ? '✓ ' : ''}${c.title}`,
    description: c.blurb
  }));
  return wa.list(
    to,
    '*Add things to your assistant.*\n\nEach one changes what I do for you. Add or remove any time — nothing to install.',
    'Choose an add-on',
    [{ title: 'Available', rows }],
    'Add-ons',
    'Or type: ADD FUEL · REMOVE FUEL · MY ADDONS'
  );
}

function addonAdd(to, hash, arg) {
  const cap = caps.resolve(arg);
  if (!cap) {
    if (!String(arg || '').trim()) return addonMenu(to, hash);
    return wa.buttons(to,
      `I don't have an add-on called "${arg}".`,
      [{ id: 'addon:menu', title: 'See add-ons' }, { id: 'menu', title: 'Main menu' }]);
  }

  caps.add(hash, cap.id);
  const s = caps.subscriber(hash);

  // Route add-on needs a route saved
  if (cap.id === 'route' && !s.route) {
    return wa.buttons(to,
      `*${cap.title} added.*\n\nWhich route do you travel most? Send it like *from to*, or share your location.`,
      [{ id: 'addon:list', title: 'My add-ons' }]);
  }

  const active = caps.list(hash).filter(c => c.active).length;
  if (cap.id === 'chart') {
    const charts = api.charts() || [];
    const lines = charts.map(c => `• *${c.authority}* — ${c.status}${c.effective_from ? ` from ${c.effective_from}` : ''}`).join('\n');
    const survey = api.survey && api.survey();
    const cover = survey && survey.loaded ? `\n\nIndex covers *${survey.stations}* stations / *${survey.routes}* routes from the 2015 survey (estimates, not an approved GPRTU chart).` : '';
    return wa.buttons(to,
      `*${cap.title} added.* ✓\n\n${cap.onAdd}${cover}${lines ? `\n\nLoaded charts:\n${lines}` : ''}\n\n_${active} add-on${active === 1 ? '' : 's'} active._`,
      [{ id: 'addon:menu', title: 'Add another' }, { id: 'addon:list', title: 'My add-ons' }]);
  }

  return wa.buttons(to,
    `*${cap.title} added.* ✓\n\n${cap.onAdd}\n\n_${active} add-on${active === 1 ? '' : 's'} active. Send REMOVE ${cap.keyword} to undo._`,
    [
      { id: 'addon:menu', title: 'Add another' },
      { id: 'addon:list', title: 'My add-ons' }
    ]);
}

function addonRemove(to, hash, arg) {
  const cap = caps.resolve(arg);
  if (!cap) return addonMenu(to, hash);
  caps.remove(hash, cap.id);
  return wa.text(to, `*${cap.title} removed.* You will not get those messages any more.`);
}

function addonList(to, hash) {
  const all = caps.list(hash);
  const active = all.filter(c => c.active);
  if (!active.length) {
    return wa.buttons(to,
      'You have no add-ons yet.\n\nAdd-ons change what I do for you — fuel alerts, road alerts, a saved route.',
      [{ id: 'addon:menu', title: 'See add-ons' }]);
  }
  const s = caps.subscriber(hash);
  const lines = active.map(c => `✓ *${c.title}* — ${c.blurb}`).join('\n');
  const routeLine = s.route ? `\n\nSaved route: *${s.route.fromName} → ${s.route.toName}* (${money(s.route.chart)})` : '';
  return wa.buttons(to,
    `*Your add-ons*\n\n${lines}${routeLine}`,
    [{ id: 'addon:menu', title: 'Add another' }, { id: 'menu', title: 'Main menu' }]);
}

/* ══════════════ ANSWERS ══════════════ */

function answerStationBoard(to, hash, stationId, metres) {
  const r = api.stationFares(stationId);
  if (!r) return wa.text(to, 'I do not have that station mapped yet.');
  caps.subscriber(hash).station = stationId;

  const rows = r.fares.map(f => {
    const q = f.queue ? `${DOT[f.queue.state]} ${f.queue.state}` : '';
    const g = f.gouging && f.gouging.pct > 0 ? ` · ⚠ +${f.gouging.pct}% reported` : '';
    const est = f.chart_status === 'estimate_pending_chart';
    return {
      id: `dest:${stationId}:${f.to}`,
      title: clip(`${f.name} ${money(f.chart)}`, 24),
      description: clip(`${est ? 'est. ' : ''}${f.bay || ''}${q ? ' · ' + q : ''}${g}`, 72)
    };
  });
  const estimate = (r.fares || []).some(f => f.chart_status === 'estimate_pending_chart');

  return wa.list(to,
    `*You're at ${r.station.name}*${metres != null ? ` _(${metres} m)_` : ''}\n\n${r.fares.length} destinations from the survey. Tap one for the queue and to report.`,
    'Choose destination',
    listSections(rows, 'Destinations'),
    null,
    estimate ? '2015 survey · estimate, not GPRTU' : 'GPRTU chart'
  );
}

function answerFare(to, hash, from, to_) {
  const r = api.fare(from, to_);
  if (!r) {
    return wa.buttons(to, `I do not have *${placeLabel(from) || from} → ${placeLabel(to_) || to_}* yet. It is queued for mapping.`,
      [{ id: 'menu', title: 'Main menu' }, { id: 'loc', title: 'Find my station' }]);
  }

  if (r.kind === 'intercity') {
    const lines = r.route.options
      .map(o => `${(o.operator + '            ').slice(0, 12)}${(o.class + '          ').slice(0, 10)}${o.band ? '₵' + o.band : money(o.amount)}`)
      .join('\n');
    const best = r.route.options.reduce((a, b) => (a.amount <= b.amount ? a : b));
    return wa.buttons(to,
      `*${r.route.from} → ${r.route.to}* · ${r.route.km} km · ${r.route.duration}\n\n\`\`\`${lines}\`\`\`\n\n*Lowest: ${best.operator} ${best.class}, ${money(best.amount)}*${prov(r)}`,
      [
        { id: `report:${from}:${to_}`, title: 'Report a fare' },
        { id: 'addon:add:CHART', title: 'Add fare alerts' }
      ]);
  }

  /* Surveyed-2015 fares are estimates. Say so, every time, in the reply. */
  const est = r.to && r.to.chart_status === 'estimate_pending_chart'
    ? `\n\n_Estimate. Based on a 2015 field survey (GH₵${r.to.fare_2015} then, route ${r.to.route_id}), re-based for inflation. Not the approved GPRTU chart — verify at the station and tell me what you paid._`
    : '';
  const q = r.queue ? `\nQueue: ${DOT[r.queue.state]} ${r.queue.state}` : '';
  const g = r.gouging && r.gouging.pct > 0
    ? `\n⚠ ${r.gouging.reports} riders report an average of ${money(r.gouging.avg_reported)} — *+${r.gouging.pct}% over chart*` : '';
  caps.subscriber(hash).context = { from: r.from.id, to: r.to.to };

  return wa.buttons(to,
    `*${r.from.name} → ${r.to.name}*\n\n${est ? 'Estimated fare' : 'Approved fare'}: *${money(r.to.chart)}*\n${r.to.bay}${q}${g}${est || prov(r)}`,
    [
      { id: `report:${r.from.id}:${r.to.to}`, title: 'Report what I paid' },
      { id: `queue:${r.from.id}:${r.to.to}`, title: 'Report the queue' },
      { id: `addon:add:MY ROUTE`, title: 'Save this route' }
    ]);
}

function answerCheapest(to, hash, from, to_) {
  const st = api.station(from);
  if (st && !to_) {
    const sorted = [...st.fares].sort((a, b) => a.chart - b.chart);
    const lines = sorted.map(f => `${(f.name + '                ').slice(0, 16)}${money(f.chart)}`).join('\n');
    const board = api.stationFares(from);
    return wa.text(to,
      `*Lowest fares from ${st.name}*\n\n\`\`\`${lines}\`\`\`\n\nCheapest: *${sorted[0].name} at ${money(sorted[0].chart)}*${prov(board)}`);
  }
  const r = api.cheapest(from, to_);
  if (!r) return wa.text(to, 'I do not have that pair yet.');
  if (r.kind === 'intercity') {
    return wa.text(to, `*Lowest on ${r.route.from} → ${r.route.to}*\n\n${r.best.operator} ${r.best.class} — *${money(r.best.amount)}*${prov(r)}`);
  }
  return answerFare(to, hash, from, to_);
}

function answerFuel(to, hash, c) {
  if (c.compare && c.places.length >= 2) {
    const [a, b] = c.places;
    const r = api.fuelCompare(a, b);
    if (!r) return wa.text(to, 'I only have Accra and Tema loaded so far.');
    const tank = (r.gap * 45).toFixed(0);
    return wa.buttons(to,
      `*Petrol — ${cap1(a)} vs ${cap1(b)}*\n\n\`\`\`${cap1(a).padEnd(9)}₵${r.a.petrol.toFixed(2)}   diesel ₵${r.a.diesel.toFixed(2)}\n${cap1(b).padEnd(9)}₵${r.b.petrol.toFixed(2)}   diesel ₵${r.b.diesel.toFixed(2)}\n${'gap'.padEnd(9)}₵${r.gap.toFixed(2)}/L\`\`\`\n\n*${cap1(r.cheaper)} is cheaper* — about ₵${tank} on a 45-litre fill.${prov(r)}`,
      [
        { id: `fuel:${a}`, title: `Stations in ${cap1(a)}` },
        { id: `fuel:${b}`, title: `Stations in ${cap1(b)}` },
        { id: 'addon:add:FUEL', title: 'Add fuel watch' }
      ]);
  }

  const area = fuelArea(hash, c);
  if (!area) {
    if ((c.places || []).length) {
      return wa.text(to, 'I only have Accra and Tema fuel prices loaded so far. Name Accra or Tema, or share your location there.');
    }
    return askPlace(to, caps.subscriber(hash), 'fuel');
  }
  const r = api.fuel(area);
  const rows = r.rows.slice(0, 8).map((s, i) => ({
    id: `fuelstation:${s.id}`,
    title: `${i === 0 ? '★ ' : ''}${s.name}`,
    description: `Petrol ₵${s.petrol.toFixed(2)} · diesel ₵${s.diesel.toFixed(2)} · ${s.confirmations} confirmations`
  }));
  return wa.list(to,
    `*Fuel — ${cap1(area)}*\nCheapest first, petrol per litre.${prov(r)}`,
    'See stations',
    [{ title: 'Petrol · per litre', rows }],
    null,
    `${r.window.window} · floor ₵${r.window.petrol_floor.toFixed(2)}`
  );
}

function placeLabel(id) {
  if (!id) return '';
  if (String(id).toLowerCase().includes('motorway')) return 'Tema Motorway';
  const st = api.station(id);
  if (st && st.name) return st.name;
  for (const stn of api.core.stations || []) {
    const f = (stn.fares || []).find(x => x.to === id);
    if (f) return f.name;
  }
  return String(id).replace(/-/g, ' ');
}

function conditionFromText(raw) {
  const t = String(raw || '').toLowerCase();
  if (/\b(clear|cleared|open|gone|fine|okay|ok)\b/.test(t)) return 'clear';
  if (/\b(slow|congestion|jam|heavy|standstill)\b/.test(t)) return 'slow';
  if (/\b(flood|flooded|rain|water)\b/.test(t)) return 'flooded';
  if (/\b(pothole|pot[- ]?hole|ditch)\b/.test(t)) return 'pothole';
  if (/\b(accident|crash|collision|pile[- ]?up)\b/.test(t)) return 'accident';
  return 'blocked';
}

function roadFromContext(c, s) {
  if (c && c.places && c.places.length >= 2) {
    return placeLabel(c.places[0]) + ' → ' + placeLabel(c.places[1]);
  }
  if (c && c.places && c.places[0]) return placeLabel(c.places[0]);
  if (s && s.context && s.context.road) return s.context.road;
  if (s && s.route) {
    const a = s.route.fromName || placeLabel(s.route.from);
    const b = s.route.toName || placeLabel(s.route.to);
    if (a && b) return a + ' → ' + b;
  }
  return 'unspecified road';
}

function answerRoad(to, hash, c) {
  const road = c.places.find(p => String(p).includes('motorway')) || c.places[0];
  const r = api.incidents(road);
  if (!r.incidents.length) {
    return wa.buttons(to, 'Nothing reported on that road in the last hour. Send a photo from WhatsApp if you can see the blockage — that picture is the report.',
      [{ id: 'addon:add:ROADS', title: 'Add road alerts' }, { id: 'menu', title: 'Main menu' }]);
  }
  const i = r.incidents[0];
  caps.subscriber(hash).context = { ...(caps.subscriber(hash).context || {}), road: i.road };
  const mins = Math.round((Date.now() - Date.parse(i.reported_at)) / 60000);
  const delayLine = i.delay ? `\nDelay       ${i.delay}` : '';
  const whereLine = i.where ? `${i.where}\n\n` : '';
  return wa.buttons(to,
    `⚠ *${i.road}*\n\n*${i.kind}*\n${whereLine}\`\`\`Reported    ${mins} min ago${delayLine}\nConfirmed   ${i.confirmations} riders\nSource      ${i.source}\`\`\`${prov(r)}`,
    [
      { id: `road:confirm:${i.id}`, title: 'Still blocked' },
      { id: `road:clear:${i.id}`, title: "It's clear now" },
      { id: 'addon:add:ROADS', title: 'Add road alerts' }
    ]);
}

function answerQueue(to, hash, c) {
  const s = caps.subscriber(hash);
  const stationId = c.places[0] || s.station || (s.route && s.route.from);
  const st = api.station(stationId);
  if (!st) return askPlace(to, caps.subscriber(hash), 'queue');
  const rows = st.fares.map(f => {
    const q = api.queue(st.id, f.to);
    return {
      id: `queue:${st.id}:${f.to}`,
      title: clip(f.name, 24),
      description: clip(q ? `${DOT[q.state]} ${q.state} · ${q.age_min}m ago · ${q.pings} pings` : 'No data yet', 72)
    };
  });
  return wa.list(to,
    `*${st.name} — loading right now*\n\nTap a bay to report what you can see. One tap.`,
    'Report a bay',
    listSections(rows, 'Bays'),
    null,
    'Rider pings only — no probe sees inside a park');
}

function answerCharts(to, hash) {
  const charts = api.charts() || [];
  const survey = api.survey();
  const lines = charts.map(c => {
    const when = c.effective_from ? String(c.effective_from).slice(0, 10) : '';
    return `• *${c.authority}* — ${c.status}${when ? ` (${when})` : ''}${c.note ? `\n  _${c.note}_` : ''}`;
  }).join('\n\n');
  const cover = survey && survey.loaded
    ? `\n\nLive index: *${survey.stations}* stations, *${survey.routes}* trotro legs from the 2015 field survey (rebased ×${survey.rebase_factor || 6.25}). Not an approved GPRTU chart.`
    : '';
  return wa.buttons(to,
    `*Fare charts*\n\n${lines || 'No charts loaded.'}${cover}`,
    [
      { id: 'addon:add:CHART', title: 'Add fare alerts' },
      { id: 'menu', title: 'Main menu' }
    ]);
}

function cap1(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }

function isPlaceDecline(raw) {
  const t = String(raw || '').trim().toLowerCase().replace(/[.!?]+$/g, '');
  return /^(no|nope|nah|no thanks|no thank you|not now|later|skip|don'?t|dont|refuse|cancel)$/.test(t)
    || /^(i )?(don'?t|dont|won'?t|will not) (want to )?(share|send)( (my )?location)?$/.test(t)
    || /^(without location|no location|type (it|the name)|i('ll| will) type( it)?)$/.test(t)
    || /\b(don'?t share|not sharing|rather not|i'll type)\b/.test(t);
}

function awaitingPlace(s) {
  return s.awaitingPlace || (s.context && s.context.awaitingPlace) || null;
}

function setAwaitingPlace(s, reason, typed) {
  s.awaitingPlace = { reason: reason || 'station', typed: !!typed, at: Date.now() };
  s.context = { ...(s.context || {}), awaitingPlace: s.awaitingPlace };
}

function clearAwaitingPlace(s) {
  s.awaitingPlace = null;
  if (s.context && s.context.awaitingPlace) {
    const next = { ...s.context };
    delete next.awaitingPlace;
    s.context = Object.keys(next).length ? next : null;
  }
}

const PLACE_ASK = {
  station: 'Share your location and I will find the nearest station.\n\nIf you would rather not, say *no* — then type any station name.',
  fare: 'Share your location to see fares from the nearest station.\n\nIf you would rather not, say *no* and type the station or route.',
  fuel: 'Share your location for fuel prices near you.\n\nIf you would rather not, say *no* and type the area or station.',
  queue: 'Share your location so I can find the loading park.\n\nIf you would rather not, say *no* and type the station name.'
};

function askPlace(to, s, reason) {
  setAwaitingPlace(s, reason, false);
  return wa.locationRequest(to, PLACE_ASK[reason] || PLACE_ASK.station);
}

function askPlaceTyped(to, s, reason) {
  setAwaitingPlace(s, reason || 'station', true);
  return wa.text(to, 'No problem. Type the station name — any park or stop you use.');
}

function fuelArea(hash, c) {
  for (const p of c.places || []) {
    const k = String(p || '').toLowerCase();
    if (k === 'accra' || k === 'tema') return k;
    const city = api.cityOf(p);
    if (city === 'accra' || city === 'tema') return city;
  }
  const stId = caps.subscriber(hash).station;
  if (stId) {
    const city = api.cityOf(stId);
    if (city === 'accra' || city === 'tema') return city;
  }
  return null;
}

function finishPlace(from, hash, s, c) {
  const reason = (awaitingPlace(s) && awaitingPlace(s).reason) || 'station';
  clearAwaitingPlace(s);
  const places = (c && c.places) || [];
  if (places[0]) caps.subscriber(hash).station = places[0];
  if (reason === 'fuel') {
    return answerFuel(from, hash, { ...(c || {}), places, compare: !!(c && c.compare) || places.length >= 2, scope: c && c.scope });
  }
  if (reason === 'queue') return answerQueue(from, hash, { places });
  if (places.length >= 2) return answerFare(from, hash, places[0], places[1]);
  if (places.length === 1) return answerStationBoard(from, hash, places[0], c && c.metres);
  return askPlace(from, s, reason);
}

async function handleTypedPlace(from, hash, s, text) {
  const waiting = awaitingPlace(s);
  if (!waiting) return null;
  if (isPlaceDecline(text)) return [askPlaceTyped(from, s, waiting.reason)];
  const c = await classify(text);
  if (c.places && c.places.length) return [finishPlace(from, hash, s, c)];
  if (c.intent && !['station', 'where', 'fare', 'fuel', 'queue'].includes(c.intent)) {
    clearAwaitingPlace(s);
    return null;
  }
  setAwaitingPlace(s, waiting.reason, true);
  return [wa.text(from, 'I do not have that name mapped yet. Try another station, or share your location.')];
}

/* ══════════════ MAIN MENU ══════════════ */

/* ═══════════════════════════════════════════════════════
   CONVERSATIONAL COMPONENTS — Meta's native "widgets".
   Configured on the phone number, not sent as messages:
     · commands      slash menu, permanent and discoverable
     · ice breakers  up to 4 tappable prompts, 80 chars, no emoji,
                     shown only on a fresh thread
     · welcome       fired by the request_welcome webhook
   Ice breakers and commands both arrive as ordinary text messages,
   so the router below handles them unchanged.
   ═══════════════════════════════════════════════════════ */
const COMMANDS = [
  { command_name: 'where',     command_description: 'Find my station and every fare from it' },
  { command_name: 'fare',      command_description: 'Check a fare — send from and to, or share location' },
  { command_name: 'fuel',      command_description: 'Cheapest fuel near me, or compare two areas' },
  { command_name: 'roads',     command_description: 'Road conditions — or send a photo to report' },
  { command_name: 'addfuel',   command_description: 'Add fuel watch — prices and change alerts' },
  { command_name: 'addroute',  command_description: 'Save my daily route' },
  { command_name: 'addroads',  command_description: 'Add road alerts on routes I use' },
  { command_name: 'myaddons',  command_description: 'See and change what is switched on' },
  { command_name: 'help',      command_description: 'Keywords and examples' },
  { command_name: 'stop',      command_description: 'Turn off all alerts' }
];

/* 4 max, 80 chars each, no emoji — Meta's limits */
const ICE_BREAKERS = [
  'Add-ons and menus',
  'Fares from my station',
  'Fuel prices near me',
  'Road conditions right now'
];

/* PATCH /{phone-number-id}/conversational_automation */
function conversationalAutomationConfig() {
  return {
    enable_welcome_message: true,
    commands: COMMANDS,
    prompts: ICE_BREAKERS
  };
}

/* Slash commands arrive as plain text. Map them to what the router knows. */
const COMMAND_MAP = {
  where: 'where', fare: 'fare', fuel: 'fuel near me', roads: 'road conditions',
  addfuel: 'add fuel', addroute: 'add my route', addroads: 'add roads',
  addqueue: 'add queue', addchart: 'add chart', addreport: 'add report',
  myaddons: 'my addons', help: 'help', stop: 'stop', menu: 'menu'
};
function expandCommand(text) {
  const m = String(text || '').trim().match(/^\/([a-z]+)\s*(.*)$/i);
  if (!m) return text;
  const cmd = m[1].toLowerCase();
  const rest = (m[2] || '').trim();
  const base = COMMAND_MAP[cmd];
  if (!base) return text;
  if (!rest) return base;
  /* /fare Tema to Accra keeps the query. /addroads gg is still add-roads. */
  if (['fare', 'fuel', 'roads', 'where', 'help'].includes(cmd)) return rest;
  return base;
}

/* Ice breaker taps arrive as their exact string. */
const ICE_MAP = {
  'add-ons and menus': 'menu',
  'fares from my station': 'where',
  'fuel prices near me': 'get me all fuel pricing in my area',
  'road conditions right now': 'road conditions',
  'add-ons: change what i do for you': 'menu'
};

/* First screen: add-ons, then things they can ask now. Hi / hello / start
   always land here so nobody has to guess a keyword. */
function startMenu(to, hash) {
  const addons = caps.list(hash).map(c => ({
    id: `addon:${c.id}`,
    title: `${c.active ? '✓ ' : ''}${c.title}`,
    description: c.blurb
  }));
  const ask = [
    { id: 'loc', title: 'Where am I?', description: 'Every fare from your station' },
    { id: 'ask:fare', title: 'Check a fare', description: 'Send from → to, or share location' },
    { id: 'ask:fuel', title: 'Fuel prices', description: 'Cheapest near you' },
    { id: 'ask:road', title: 'Road conditions', description: 'Ask, or send a photo from WhatsApp' }
  ];
  return wa.list(
    to,
    '*Welcome to GH Fares.* Tap an add-on, pick something to ask, or type a question — like *what is the road condition right now*.',
    'Choose',
    [
      { title: 'Add-ons', rows: addons },
      { title: 'Ask now', rows: ask }
    ],
    'GH Fares',
    'Or type a route · /fare · /roads · or share your location'
  );
}

function welcome(to, hash) {
  const s = caps.subscriber(hash);
  s.onboarded = true;
  s.welcomedAt = Date.now();
  return [startMenu(to, hash)];
}

/* Reference card — reachable any time with HELP or KEYWORDS. */
function keywordCard(to, hash) {
  const s = caps.subscriber(hash);
  const active = [...s.caps].map(id => caps.byId[id].keyword);
  return wa.buttons(to,
`*How to talk to me*

*Ask naturally*
\u2022 from → to
\u2022 cheapest from my station
\u2022 fuel near me
\u2022 what's happening on the road
\u2022 send a photo of the road (caption it if you can)

*Keywords*
\u2022 *MENU* \u2014 everything I can do
\u2022 *WHERE* \u2014 find your station
\u2022 *ADD FUEL / ROADS / MY ROUTE / QUEUE / CHART / REPORT*
\u2022 *MY ADDONS* \u2014 what's switched on${active.length ? ` (now: ${active.join(', ')})` : ''}
\u2022 *REMOVE FUEL* \u2014 switch one off
\u2022 *STOP* \u2014 turn off all alerts`,
    [
      { id: 'addon:menu', title: 'See add-ons' },
      { id: 'loc', title: 'Find my station' }
    ]);
}

function mainMenu(to, hash) {
  const s = caps.subscriber(hash);
  const rows = [
    { id: 'loc', title: 'Where am I?', description: 'Share location — every fare from your station' },
    { id: 'ask:fare', title: 'Check a fare', description: 'Send from → to, or share your location' },
    { id: 'ask:fuel', title: 'Fuel prices', description: 'Cheapest near you, or compare two areas' },
    { id: 'ask:road', title: 'Road conditions', description: 'Live incidents — or send a photo to report' },
    { id: 'addon:menu', title: 'Add-ons', description: `${s.caps.size} active — change what I do for you` },
    { id: 'help', title: 'How to talk to me', description: 'Keywords and examples' }
  ];
  return wa.list(to,
    '*GH Fares.* Approved fares, live queues, fuel and road conditions — ask in your own words.',
    'Open menu',
    [{ title: 'What do you need?', rows }],
    null,
    'Send ADD to change what I do for you');
}

/* ══════════════ ROUTER ══════════════ */

let lastParse = { intent: null, places: [], via: 'api' };

async function handle({ from, hash, text, interactiveId, location, type, channel, image }) {
  lastParse = {
    intent: type || (interactiveId ? 'tap' : location ? 'where' : image ? 'road' : null),
    places: [],
    via: 'api'
  };
  await caps.ready();
  await require('./api').ready();
  await require('./broadcast').ready();
  const s = await caps.ensure(hash, channel);
  try {
    return await dispatch({ from, hash, text, interactiveId, location, type, s, image });
  } finally {
    await caps.flush(hash, channel);
  }
}

async function handleRoadPhoto(from, hash, image, s) {
  const caption = String((image && image.caption) || '').trim();
  const c = await classify(caption);
  lastParse = { ...c, intent: 'road' };
  const road = roadFromContext(c, s);
  const condition = conditionFromText(caption);
  const bytes = image && image.bytes;
  const hasBytes = !!(bytes && (Buffer.isBuffer(bytes) ? bytes.length : Buffer.from(bytes).length));
  const r = await api.reportRoadPhoto({
    road,
    condition,
    caption: caption || null,
    mime: (image && image.mime) || 'image/jpeg',
    bytes: hasBytes ? bytes : null,
    wa_media_id: (image && (image.wa_media_id || image.id)) || null,
    hash
  });
  s.context = { ...(s.context || {}), road };
  s.lastIntent = 'road';

  if (!hasBytes) {
    return wa.text(from, 'I could not pull that photo from WhatsApp. Send it again from the camera, and add a caption like *motorway blocked* if you can.');
  }

  const logged = r.stored || !r.neon
    ? `Photo saved — *${road}* logged as ${condition}.`
    : `I received the photo of *${road}* but could not store the file. The condition is still logged as ${condition}.`;
  if (!caps.has(hash, 'roads')) {
    return wa.buttons(from,
      logged + '\n\nSend *ADD ROADS* if you want alerts when this corridor changes.',
      [{ id: 'addon:add:ROADS', title: 'Add road alerts' }, { id: 'menu', title: 'Main menu' }]);
  }
  return wa.buttons(from,
    logged + '\n\nRiders with road alerts on this corridor will see the update.',
    [{ id: 'ask:road', title: 'Road conditions' }, { id: 'menu', title: 'Main menu' }]);
}

async function handleRoadTextReport(from, hash, c, s, text) {
  const raw = String(text || '').trim();
  const vague = /^(i want to report( it)?( myself)?|let me report( it)?|report( it)?( myself)?)\.?$/i.test(raw);
  const road = roadFromContext(c, s);
  const named = road !== 'unspecified road';
  if (vague || !named) {
    const hint = named ? ` of *${road}*` : '';
    return wa.buttons(from,
      `Send a photo${hint} from WhatsApp, or say what you see — like *pothole on the motorway* or *the road is blocked*.`,
      [{ id: 'addon:add:ROADS', title: 'Add road alerts' }, { id: 'menu', title: 'Main menu' }]);
  }
  const condition = conditionFromText(raw);
  await api.reportRoad(road, condition, {
    kind: condition,
    where: raw,
    hash
  });
  s.context = { ...(s.context || {}), road };
  s.lastIntent = 'road';
  const logged = `Logged — *${road}* as ${condition}.`;
  if (!caps.has(hash, 'roads')) {
    return wa.buttons(from,
      logged + '\n\nSend a photo if you have one. Send *ADD ROADS* if you want alerts when this corridor changes.',
      [{ id: 'addon:add:ROADS', title: 'Add road alerts' }, { id: 'menu', title: 'Main menu' }]);
  }
  return wa.buttons(from,
    logged + '\n\nSend a photo if you have one. Riders with road alerts on this corridor will see the update.',
    [{ id: 'ask:road', title: 'Road conditions' }, { id: 'menu', title: 'Main menu' }]);
}

async function dispatch({ from, hash, text, interactiveId, location, type, s, image }) {

  /* Meta fires this when someone opens a chat with no existing thread.
     It also opens the service window, so we may reply free-form. */
  if (type === 'request_welcome') return welcome(from, hash);

  if (image || type === 'image') return [await handleRoadPhoto(from, hash, image || {}, s)];

  /* location share → nearest station, then whatever we were asking */
  if (location) {
    const reason = (awaitingPlace(s) && awaitingPlace(s).reason) || 'station';
    const near = api.stationsNear(location.latitude, location.longitude);
    if (!near.station || near.too_far) {
      const km = near.metres != null ? Math.round(near.metres / 1000) : null;
      const hint = near.station && km != null
        ? `That pin is about ${km} km from the nearest mapped station (*${near.station.name}*). `
        : '';
      setAwaitingPlace(s, reason, true);
      return [wa.text(from, hint + 'Type the station name, or share again when you are at a Ghana station.')];
    }
    return [finishPlace(from, hash, s, { places: [near.station.id], metres: near.metres })];
  }

  /* interactive taps */
  if (interactiveId) {
    const p = interactiveId.split(':');
    if (p[0] === 'addon') {
      if (p[1] === 'menu') return [addonMenu(from, hash)];
      if (p[1] === 'list') return [addonList(from, hash)];
      if (p[1] === 'add') return [addonAdd(from, hash, p.slice(2).join(':'))];
      return [addonAdd(from, hash, caps.byId[p[1]] ? caps.byId[p[1]].keyword : p[1])];
    }
    if (p[0] === 'dest') return [answerFare(from, hash, p[1], p[2])];
    if (p[0] === 'report') {
      const f = api.fare(p[1], p[2]);
      if (!f || f.kind !== 'leg') {
        return [wa.text(from, 'I do not have that pair mapped yet — send the route and I will look it up.')];
      }
      s.pending = { from: p[1], to: p[2] };
      return [wa.text(from, `*Report a fare*\n\n${f.from.name} → ${f.to.name}\n${f.to.chart_status === 'estimate_pending_chart' ? 'Estimated' : 'Approved'}: *${money(f.to.chart)}*\n\nHow much were you charged? Send the amount only.`)]; }
    if (p[0] === 'queue') {
      if (p[3]) {
        const r = await api.reportQueue(p[1], p[2], p[3], hash);
        const st0 = api.station(p[1]);
        const d0 = st0 && st0.fares.find(f => f.to === p[2]);
        return [wa.text(from, `Logged — *${st0 ? st0.name.split(' ')[0] : p[1]} → ${d0 ? d0.name : p[2]}: ${p[3]}*.\n\n${r.pings} pings today. Watchers on this corridor are being notified now.`)]; }
      const qst = api.station(p[1]);
      const qdest = qst && qst.fares.find(f => f.to === p[2]);
      return [wa.buttons(from, `*${qst ? qst.name : p[1]} → ${qdest ? qdest.name : p[2]}*\n\nHow is the queue right now?`, [
        { id: `queue:${p[1]}:${p[2]}:moving`, title: '🟢 Moving' },
        { id: `queue:${p[1]}:${p[2]}:slow`, title: '🟡 Slow' },
        { id: `queue:${p[1]}:${p[2]}:stuck`, title: '🔴 Stuck' }])];
    }
    if (p[0] === 'fuel') return [answerFuel(from, hash, { places: [p[1]], compare: false, scope: null })];
    if (p[0] === 'road') {
      const inc = api.core.incidents.find(i => i.id === p[2]);
      if (p[1] === 'confirm' && inc) {
        inc.confirmations++;
        inc.reported_at = new Date().toISOString();
        await api.reportRoad(inc.road, inc.kind || 'blocked', {
          id: inc.id, kind: inc.kind, where: inc.where, delay: inc.delay,
          hash, status: 'live', confirmations: inc.confirmations
        });
        return [wa.text(from, `Confirmed — *${inc.road}* still blocked. Now ${inc.confirmations} rider confirmations.`)];
      }
      if (p[1] === 'clear' && inc) {
        inc.status = 'cleared';
        await api.reportRoad(inc.road, 'clear', {
          id: inc.id, kind: inc.kind, where: inc.where, delay: inc.delay,
          hash, status: 'cleared', confirmations: inc.confirmations
        });
        return [wa.text(from, `Cleared — *${inc.road}* removed from live state on your report.\n\nOne rider on the spot beats an hour-old probe.`)];
      }
    }
    if (p[0] === 'loc') return [askPlace(from, s, 'station')];
    if (p[0] === 'place') return [askPlaceTyped(from, s, (awaitingPlace(s) && awaitingPlace(s).reason) || 'station')];
    if (p[0] === 'menu') return [startMenu(from, hash)];
    if (p[0] === 'help') return [keywordCard(from, hash)];
    if (p[0] === 'ask') {
      if (p[1] === 'fuel') return [answerFuel(from, hash, { places: [], compare: false, scope: 'here' })];
      if (p[1] === 'road') return [answerRoad(from, hash, { places: [], compare: false })];
      return [askPlace(from, s, 'fare')];
    }
    if (p[0] === 'fuelstation') {
      const st = api.core.fuel.stations.find(x => x.id === p[1]);
      return [wa.buttons(from, `*${st.name}*\n\n\`\`\`Petrol   ₵${st.petrol.toFixed(2)}/L\nDiesel   ₵${st.diesel.toFixed(2)}/L\nArea     ${st.area}\nConfirm  ${st.confirmations} riders\`\`\``,
        [{ id: 'addon:add:FUEL', title: 'Add fuel watch' }, { id: 'menu', title: 'Main menu' }])];
    }
  }

  /* Conversational Components arrive as text — normalise them first. */
  if (text) {
    if (/^delete my data$/i.test(String(text).trim()) || /^forget me$/i.test(String(text).trim())) {
      caps.forget(hash);
      return [wa.text(from, 'Your GH Fares data for this chat is deleted — add-ons, saved station, route, and road photos. Message history inside WhatsApp or Messenger is still held by Meta. Send *hi* if you want to start again.')];
    }
    const ice = ICE_MAP[String(text).trim().toLowerCase()];
    if (ice) text = ice;
    else if (String(text).trim().startsWith('/')) text = expandCommand(text);
  }

  if (text && awaitingPlace(s)) {
    const placed = await handleTypedPlace(from, hash, s, text);
    if (placed) return placed;
  }

  const c = await classify(text);
  lastParse = c;

  /* pending fare amount */
  if (s.pending && c.amount != null) {
    const r = await api.reportFare(s.pending.from, s.pending.to, c.amount, hash);
    s.pending = null;
    if (!r) return [wa.text(from, 'Could not log that one.')];
    const over = c.amount > r.chart;
    return [wa.buttons(from,
      over
        ? `Logged — *${money(c.amount)}* against a chart of ${money(r.chart)}.\n\n*${r.reports} riders* have now reported at ${r.station}, averaging *${money(r.avg_reported)}* — *+${r.pct}% over*.\n\n_Counts, never accusations. No driver named._`
        : `Logged at chart — ${money(c.amount)}. Compliance reports count too; they show where the system works.`,
      [{ id: 'addon:add:REPORT', title: 'Add quick report' }, { id: 'menu', title: 'Main menu' }])];
  }

  /* quick-report add-on: a bare number with a saved route needs no context.
     Must run before the switch — the classifier defaults bare numbers to menu. */
  if (c.amount != null && /^[\d.\s₵]+$/.test(String(text || '')) &&
      caps.granted(hash, 'report.fast') && s.route) {
    const r = await api.reportFare(s.route.from, s.route.to, c.amount, hash);
    if (r) return [wa.text(from, `Logged *${money(c.amount)}* on ${r.station} → ${r.dest}. ${r.reports} reports, averaging ${money(r.avg_reported)}.`)];
  }

  switch (c.intent) {
    case 'addon_add': return [addonAdd(from, hash, c.arg)];
    case 'addon_remove': return [addonRemove(from, hash, c.arg)];
    case 'addon_list': return [addonList(from, hash)];
    case 'greet':
    case 'menu':
      if (c.intent === 'greet' && s.welcomedAt && Date.now() - s.welcomedAt < 2 * 60 * 1000) {
        return [wa.text(from, 'Tap *Choose* for add-ons, or ask in your own words — *what is the road condition right now*.')];
      }
      s.onboarded = true;
      s.welcomedAt = Date.now();
      return [startMenu(from, hash)];
    case 'help': return [keywordCard(from, hash)];
    case 'where': return [askPlace(from, s, 'station')];
    case 'fuel': return [answerFuel(from, hash, c)];
    case 'road':
      if (c.reporting) return [await handleRoadTextReport(from, hash, c, s, text)];
      return [answerRoad(from, hash, c)];
    case 'queue': return [answerQueue(from, hash, c)];
    case 'chart': return [answerCharts(from, hash)];
    case 'cheapest':
      if (!(c.places[0] || s.station)) return [askPlace(from, s, 'fare')];
      return [answerCheapest(from, hash, c.places[0] || s.station, c.places[1])];
    case 'fare': {
      if (c.places.length >= 2) {
        // saving a route for the MY ROUTE add-on
        if (caps.has(hash, 'route') && !s.route) {
          const f = api.fare(c.places[0], c.places[1]);
          if (f && f.kind === 'leg') {
            s.route = { from: f.from.id, to: f.to.to, fromName: f.from.name, toName: f.to.name, chart: f.to.chart };
            return [wa.buttons(from, `*Route saved — ${f.from.name} → ${f.to.name}* (${money(f.to.chart)}).\n\nNow just send *how much*, *queue*, or an amount like *10* and I will assume this route.`,
              [{ id: 'addon:list', title: 'My add-ons' }])];
          }
        }
        return [answerFare(from, hash, c.places[0], c.places[1])];
      }
      if (s.route && caps.granted(hash, 'route.default')) return [answerFare(from, hash, s.route.from, s.route.to)];
      if (c.places.length === 1) return [answerStationBoard(from, hash, c.places[0])];
      return [askPlace(from, s, 'fare')];
    }
    case 'station':
      if (!c.places[0]) return [askPlace(from, s, 'station')];
      return [answerStationBoard(from, hash, c.places[0])];
    case 'incident_history': return [answerRoad(from, hash, c)];
    default:
      return [wa.buttons(from, "I didn't catch that — it's logged so the parser learns from it.",
        [{ id: 'menu', title: 'Main menu' }, { id: 'addon:menu', title: 'Add-ons' }, { id: 'loc', title: 'Find my station' }])];
  }
}

/* ══════════════ PROACTIVE PUSH ══════════════
   Everything below is business-initiated, so it MUST use an approved
   template. This is where add-ons earn their keep — and where they cost
   money, which is why they only fire on genuine state change. */

function pushFuelAlert(stationName, area, oldPrice, newPrice) {
  return caps.audience('fuel').map(s =>
    wa.template(s.hash, 'fuel_price_change', 'en', [stationName, area, `₵${oldPrice.toFixed(2)}`, `₵${newPrice.toFixed(2)}`]));
}
function pushRoadAlert(road, kind, delay) {
  return caps.audience('roads').map(s =>
    wa.template(s.hash, 'road_incident', 'en', [road, kind, delay]));
}
function pushQueueAlert(stationName, dest, state) {
  return caps.audience('queue').map(s =>
    wa.template(s.hash, 'queue_state_change', 'en', [stationName, dest, state]));
}
function pushChartRevision(authority, effective, routeName, oldF, newF) {
  return caps.audience('chart').map(s =>
    wa.template(s.hash, 'fare_chart_revision', 'en', [authority, effective, routeName, `₵${oldF}`, `₵${newF}`]));
}

module.exports = { handle, welcome, startMenu, keywordCard, mainMenu, addonMenu,
  COMMANDS, ICE_BREAKERS, ICE_MAP, conversationalAutomationConfig, expandCommand, pushFuelAlert, pushRoadAlert, pushQueueAlert, pushChartRevision,
  get lastParse() { return lastParse; } };
