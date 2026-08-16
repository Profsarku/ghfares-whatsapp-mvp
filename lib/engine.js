const wa = require('./wa');
const caps = require('./capabilities');
const { classify, api } = require('./api');

const money = n => `₵${Number(n).toFixed(2).replace(/\.00$/, '')}`;
const DOT = { moving: '🟢', slow: '🟡', stuck: '🔴' };

/** Provenance line — appended to every substantive answer. */
function prov(r) {
  if (!r) return '';
  if (r.source === 'published') return `\n\n_${r.authority} · published data_`;
  if (r.source === 'crowd') return `\n\n_${r.authority} · accuracy grows with reports_`;
  return `\n\n_${r.authority}_`;
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
  const key = String(arg || '').toUpperCase().trim();
  if (!key) return addonMenu(to, hash);

  const cap = caps.byKeyword[key] ||
    caps.CAPABILITIES.find(c => c.id === key.toLowerCase() || c.title.toUpperCase().includes(key));
  if (!cap) {
    return wa.buttons(to,
      `I don't have an add-on called "${arg}".`,
      [{ id: 'addon:menu', title: 'See add-ons' }, { id: 'menu', title: 'Main menu' }]);
  }

  caps.add(hash, cap.id);
  const s = caps.subscriber(hash);

  // Route add-on needs a route saved
  if (cap.id === 'route' && !s.route) {
    return wa.buttons(to,
      `*${cap.title} added.*\n\nWhich route do you travel most? Send it like *kasoa to circle*.`,
      [{ id: 'addon:list', title: 'My add-ons' }]);
  }

  const active = caps.list(hash).filter(c => c.active).length;
  return wa.buttons(to,
    `*${cap.title} added.* ✓\n\n${cap.onAdd}\n\n_${active} add-on${active === 1 ? '' : 's'} active. Send REMOVE ${cap.keyword} to undo._`,
    [
      { id: 'addon:menu', title: 'Add another' },
      { id: 'addon:list', title: 'My add-ons' }
    ]);
}

function addonRemove(to, hash, arg) {
  const key = String(arg || '').toUpperCase().trim();
  const cap = caps.byKeyword[key] || caps.CAPABILITIES.find(c => c.id === key.toLowerCase());
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
    return { id: `dest:${stationId}:${f.to}`, title: `${f.name} — ${money(f.chart)}`, description: `${f.bay}${q ? ' · ' + q : ''}${g}` };
  });

  return wa.list(to,
    `*You're at ${r.station.name}*${metres != null ? ` _(${metres} m)_` : ''}\n\nEvery direction from here, with the approved fare. Tap one for the queue and to report.`,
    'Choose destination',
    [{ title: 'Destinations', rows }],
    null,
    'GPRTU chart eff. 2 Jun 2026'
  );
}

function answerFare(to, hash, from, to_) {
  const r = api.fare(from, to_);
  if (!r) {
    return wa.buttons(to, `I do not have *${from} → ${to_}* yet. It is queued for mapping.`,
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
    return wa.text(to,
      `*Lowest fares from ${st.name}*\n\n\`\`\`${lines}\`\`\`\n\nCheapest: *${sorted[0].name} at ${money(sorted[0].chart)}*${prov({ source: 'published', authority: 'GPRTU chart eff. 2 Jun 2026' })}`);
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

  const area = c.places.find(p => ['accra', 'tema'].includes(p)) || (c.scope === 'here' ? 'Accra' : null);
  const r = api.fuel(area);
  const rows = r.rows.slice(0, 8).map((s, i) => ({
    id: `fuelstation:${s.id}`,
    title: `${i === 0 ? '★ ' : ''}${s.name}`,
    description: `Petrol ₵${s.petrol.toFixed(2)} · diesel ₵${s.diesel.toFixed(2)} · ${s.confirmations} confirmations`
  }));
  return wa.list(to,
    `*Fuel — ${area ? cap1(area) : 'Accra & Tema'}*\nCheapest first, petrol per litre.${prov(r)}`,
    'See stations',
    [{ title: 'Petrol · per litre', rows }],
    null,
    `${r.window.window} · floor ₵${r.window.petrol_floor.toFixed(2)}`
  );
}

function answerRoad(to, hash, c) {
  const road = c.places.find(p => String(p).includes('motorway')) || c.places[0];
  const r = api.incidents(road);
  if (!r.incidents.length) {
    return wa.buttons(to, 'Nothing reported on that road in the last hour.',
      [{ id: 'addon:add:ROADS', title: 'Add road alerts' }, { id: 'menu', title: 'Main menu' }]);
  }
  const i = r.incidents[0];
  const mins = Math.round((Date.now() - Date.parse(i.reported_at)) / 60000);
  return wa.buttons(to,
    `⚠ *${i.road}*\n\n*${i.kind}*\n${i.where}\n\n\`\`\`Reported    ${mins} min ago\nDelay       ${i.delay}\nConfirmed   ${i.confirmations} riders\nSource      ${i.source}\`\`\`${prov(r)}`,
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
  if (!st) return wa.locationRequest(to, 'Which station? Share your location and I will find it.');
  const rows = st.fares.map(f => {
    const q = api.queue(st.id, f.to);
    return {
      id: `queue:${st.id}:${f.to}`,
      title: f.name,
      description: q ? `${DOT[q.state]} ${q.state} · ${q.age_min}m ago · ${q.pings} pings` : 'No data yet'
    };
  });
  return wa.list(to,
    `*${st.name} — loading right now*\n\nTap a bay to report what you can see. One tap.`,
    'Report a bay',
    [{ title: 'Bays', rows }],
    null,
    'Rider pings only — no probe sees inside a park');
}

function cap1(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }

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
  { command_name: 'fare',      command_description: 'Check a fare, e.g. /fare kaneshie to bubuashie' },
  { command_name: 'fuel',      command_description: 'Cheapest fuel near me, or compare two areas' },
  { command_name: 'roads',     command_description: 'What is blocking the road right now' },
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
  const base = COMMAND_MAP[m[1].toLowerCase()];
  if (!base) return text;
  return m[2] ? `${m[2]}` : base;         // "/fare kaneshie to circle" → the route itself
}

/* Ice breaker taps arrive as their exact string. */
const ICE_MAP = {
  'add-ons and menus': 'hi',
  'fares from my station': 'where',
  'fuel prices near me': 'get me all fuel pricing in my area',
  'road conditions right now': 'road conditions',
  'add-ons: change what i do for you': 'hi'
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
    { id: 'ask:fare', title: 'Check a fare', description: 'Send: kaneshie to bubuashie' },
    { id: 'ask:fuel', title: 'Fuel prices', description: 'Cheapest near you' },
    { id: 'ask:road', title: 'Road conditions', description: 'What is blocking the road' }
  ];
  return wa.list(
    to,
    '*Welcome to GH Fares.* Tap an add-on to switch it on, or pick something to ask now.',
    'Choose',
    [
      { title: 'Add-ons', rows: addons },
      { title: 'Ask now', rows: ask }
    ],
    'GH Fares',
    'Or type: kaneshie to bubuashie'
  );
}

function welcome(to, hash) {
  caps.subscriber(hash).onboarded = true;
  return [startMenu(to, hash)];
}

/* Reference card — reachable any time with HELP or KEYWORDS. */
function keywordCard(to, hash) {
  const s = caps.subscriber(hash);
  const active = [...s.caps].map(id => caps.byId[id].keyword);
  return wa.buttons(to,
`*How to talk to me*

*Ask naturally*
\u2022 kaneshie to bubuashie
\u2022 cheapest from kaneshie
\u2022 fuel in accra compared to tema
\u2022 what's happening on circle to madina

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
    { id: 'ask:fare', title: 'Check a fare', description: 'Send it like: kaneshie to bubuashie' },
    { id: 'ask:fuel', title: 'Fuel prices', description: 'Cheapest near you, or compare two areas' },
    { id: 'ask:road', title: 'Road conditions', description: 'What is blocking the road right now' },
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

function handle({ from, hash, text, interactiveId, location, type }) {
  const s = caps.subscriber(hash);

  /* Meta fires this when someone opens a chat with no existing thread.
     It also opens the service window, so we may reply free-form. */
  if (type === 'request_welcome') return welcome(from, hash);

  /* location share → station board */
  if (location) {
    const near = api.stationsNear(location.latitude, location.longitude);
    return [answerStationBoard(from, hash, near.station.id, near.metres)];
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
        const r = api.reportQueue(p[1], p[2], p[3]);
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
      if (p[1] === 'confirm' && inc) { inc.confirmations++; inc.reported_at = new Date().toISOString();
        return [wa.text(from, `Confirmed — *${inc.road}* still blocked. Now ${inc.confirmations} rider confirmations.`)]; }
      if (p[1] === 'clear' && inc) { inc.status = 'cleared';
        return [wa.text(from, `Cleared — *${inc.road}* removed from live state on your report.\n\nOne rider on the spot beats an hour-old probe.`)]; }
    }
    if (p[0] === 'loc') return [wa.locationRequest(from, 'Share your location and I will show every fare from your station.')];
    if (p[0] === 'menu') return [startMenu(from, hash)];
    if (p[0] === 'help') return [keywordCard(from, hash)];
    if (p[0] === 'ask') {
      const hints = { fare: 'Send it like *kaneshie to bubuashie*.', fuel: 'Send *fuel near me* or *accra vs tema*.', road: 'Send *what is happening on tema motorway*.' };
      return [wa.text(from, hints[p[1]] || 'Ask me anything transport.')];
    }
    if (p[0] === 'fuelstation') {
      const st = api.core.fuel.stations.find(x => x.id === p[1]);
      return [wa.buttons(from, `*${st.name}*\n\n\`\`\`Petrol   ₵${st.petrol.toFixed(2)}/L\nDiesel   ₵${st.diesel.toFixed(2)}/L\nArea     ${st.area}\nConfirm  ${st.confirmations} riders\`\`\``,
        [{ id: 'addon:add:FUEL', title: 'Add fuel watch' }, { id: 'menu', title: 'Main menu' }])];
    }
  }

  /* Conversational Components arrive as text — normalise them first. */
  if (text) {
    const ice = ICE_MAP[String(text).trim().toLowerCase()];
    if (ice) text = ice;
    else if (String(text).trim().startsWith('/')) text = expandCommand(text);
  }

  const c = classify(text);

  /* pending fare amount */
  if (s.pending && c.amount != null) {
    const r = api.reportFare(s.pending.from, s.pending.to, c.amount);
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
    const r = api.reportFare(s.route.from, s.route.to, c.amount);
    if (r) return [wa.text(from, `Logged *${money(c.amount)}* on ${r.station} → ${r.dest}. ${r.reports} reports, averaging ${money(r.avg_reported)}.`)];
  }

  switch (c.intent) {
    case 'addon_add': return [addonAdd(from, hash, c.arg)];
    case 'addon_remove': return [addonRemove(from, hash, c.arg)];
    case 'addon_list': return [addonList(from, hash)];
    case 'menu':
      s.onboarded = true;
      return [startMenu(from, hash)];
    case 'help': return [keywordCard(from, hash)];
    case 'where': return [wa.locationRequest(from, 'Share your location and I will show every fare from your station.')];
    case 'fuel': return [answerFuel(from, hash, c)];
    case 'road': return [answerRoad(from, hash, c)];
    case 'queue': return [answerQueue(from, hash, c)];
    case 'cheapest': return [answerCheapest(from, hash, c.places[0] || s.station, c.places[1])];
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
      return [wa.locationRequest(from, 'Which station are you at? Share your location, or send it like *kaneshie to bubuashie*.')];
    }
    case 'station': return [answerStationBoard(from, hash, c.places[0])];
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
  COMMANDS, ICE_BREAKERS, ICE_MAP, conversationalAutomationConfig, expandCommand, pushFuelAlert, pushRoadAlert, pushQueueAlert, pushChartRevision };
