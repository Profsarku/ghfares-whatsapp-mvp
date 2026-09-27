const wa = require('./wa');
const caps = require('./capabilities');
const { classify, api, routeMention, exactPlace } = require('./api');
const countries = require('./countries');
const memory = require('./memory');
const crowd = require('./crowd');
const locationLink = require('./location-link');

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

  if (cap.id === 'location') {
    setAwaitingPlace(s, 'station', false);
    return wa.locationRequest(to,
      '*My location*\n\nSend where you are in any of these ways. I only use it to answer this chat.\n\n*Share* — tap the location button below.');
  }

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
  if (!r) return askWhereNow(to, caps.subscriber(hash), 'station');
  caps.subscriber(hash).station = stationId;
  if (!(r.fares || []).length) {
    const where = r.station.region ? ` · ${r.station.region}` : '';
    return wa.buttons(to,
      `*${r.station.name}*${where} is on the map.\n\nI do not have fares from this park yet. Share where you are if you want the nearest park that has a fare.`,
      [{ id: 'loc', title: 'Where I am' }, { id: 'menu', title: 'Main menu' }]);
  }

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
    if (!api.station(from) || !api.station(to_)) {
      return askWhereNow(to, caps.subscriber(hash), 'fare', `${placeLabel(from) || from} to ${placeLabel(to_) || to_}`);
    }
    return wa.buttons(to, `I do not have a fare for *${placeLabel(from) || from} → ${placeLabel(to_) || to_}* yet. Both places are on the map.`,
      [{ id: 'loc', title: 'Where I am' }, { id: 'menu', title: 'Main menu' }]);
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
    if (!(st.fares || []).length) return answerStationBoard(to, hash, from);
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
      const name = placeLabel(c.places[0]) || c.places[0];
      if (!api.station(c.places[0])) return askWhereNow(to, caps.subscriber(hash), 'fuel', name);
      setAwaitingPlace(caps.subscriber(hash), 'fuel', false);
      return wa.locationRequest(to, `I only have Accra and Tema fuel prices, not *${name}*.\n\n*Where are you now?*\n\nShare your location and I will use the nearest station.`);
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
  if (!st) return askWhereNow(to, caps.subscriber(hash), 'queue');
  if (!(st.fares || []).length) {
    return wa.buttons(to,
      `*${st.name}* is on the map. I do not have loading bays for this park yet.`,
      [{ id: 'loc', title: 'Where I am' }, { id: 'menu', title: 'Main menu' }]);
  }
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
  station: '*Where are you now?*\n\nShare your location and I will use the nearest station on the map.\n\nIf you would rather not, say *no* and type the station.',
  fare: '*Where are you now?*\n\nShare your location and I will use fares from the nearest station.\n\nIf you would rather not, say *no* and type the station or route.',
  fuel: '*Where are you now?*\n\nShare your location for fuel prices near you.\n\nIf you would rather not, say *no* and type the area or station.',
  queue: '*Where are you now?*\n\nShare your location and I will use the nearest loading park.\n\nIf you would rather not, say *no* and type the station.'
};

function askWhereNow(to, s, reason, missing) {
  setAwaitingPlace(s, reason || 'station', false);
  const named = missing
    ? `I do not have *${String(missing).replace(/\*/g, '').trim()}* on the map yet.\n\n`
    : '';
  return wa.locationRequest(to, named + '*Where are you now?*\n\nShare your location and I will use the nearest station.');
}

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
  if (c.intent && ['greet', 'help', 'addon_add', 'addon_remove', 'addon_list', 'road'].includes(c.intent) && c.nlu !== 'heuristic') {
    clearAwaitingPlace(s);
    return null;
  }
  return [askWhereNow(from, s, waiting.reason, text)];
}

function awaitingCountry(s) {
  return !!(s.awaitingCountry || (s.context && s.context.awaitingCountry));
}

function setAwaitingCountry(s, typed) {
  s.awaitingCountry = { typed: !!typed, at: Date.now() };
  s.context = { ...(s.context || {}), awaitingCountry: s.awaitingCountry };
}

function clearAwaitingCountry(s) {
  s.awaitingCountry = null;
  if (s.context && s.context.awaitingCountry) {
    const next = { ...s.context };
    delete next.awaitingCountry;
    s.context = Object.keys(next).length ? next : null;
  }
}

function setCountry(s, iso) {
  const row = countries.get(iso);
  s.country = row ? row.iso : iso;
  s.context = { ...(s.context || {}), country: s.country };
  clearAwaitingCountry(s);
  return row;
}

function askCountry(to, s) {
  setAwaitingCountry(s, false);
  return wa.locationRequest(to,
    '*Which country are you in?*\n\nShare your location in WhatsApp and I will use only that country\'s data.\n\nIf you would rather not, say *no* and type the country — like *Ghana* or *USA*.');
}

function askCountryTyped(to, s) {
  setAwaitingCountry(s, true);
  return wa.text(to, 'No problem. Type the country — like *Ghana* or *USA*.');
}

function noCountryData(to, s, row) {
  const name = (row && row.name) || 'this country';
  return wa.buttons(to,
    `We don't have data for *${name}* yet.\n\nGH Fares is live in *Ghana*. Share your WhatsApp location there, type *Ghana*, or try another country.`,
    [{ id: 'country:gh', title: 'Use Ghana' }, { id: 'country:ask', title: 'Another country' }]);
}

function afterCountry(to, hash, s, row) {
  if (!row) {
    return wa.text(to, 'I don\'t have that country mapped yet. Share your WhatsApp location, or type a country name.');
  }
  if (!countries.isLive(row.iso)) return noCountryData(to, s, row);
  s.onboarded = true;
  s.welcomedAt = Date.now();
  return startMenu(to, hash);
}

function applyCountryFromCoords(s, lat, lng) {
  const row = countries.fromCoords(lat, lng);
  if (!row) return null;
  setCountry(s, row.iso);
  return row;
}

function liveCountry(s) {
  return countries.isLive(s.country);
}

function awaitingRoadWhere(s) {
  return s.awaitingRoadWhere || (s.context && s.context.awaitingRoadWhere) || null;
}

function setAwaitingRoadWhere(s, extra, typed) {
  s.awaitingRoadWhere = { ...(extra || {}), typed: !!typed, at: Date.now() };
  s.context = { ...(s.context || {}), awaitingRoadWhere: s.awaitingRoadWhere };
}

function clearAwaitingRoadWhere(s) {
  s.awaitingRoadWhere = null;
  if (s.context && s.context.awaitingRoadWhere) {
    const next = { ...s.context };
    delete next.awaitingRoadWhere;
    s.context = Object.keys(next).length ? next : null;
  }
}

function inferPhotoKind(check, caption, condition) {
  if (check && check.kind) return check.kind;
  const cap = String(caption || '').toLowerCase();
  if (/\b(accident|crash|collision|wreck|pile[- ]?up|knocked)\b/.test(cap)) return 'accident';
  if (/\b(car|vehicle|trotro|bus|taxi|okada)\b/.test(cap)
      && !/\b(pothole|blocked|flood|flooded|bad road|motorway)\b/.test(cap)) {
    return 'vehicle';
  }
  const t = `${cap} ${condition || ''}`.toLowerCase();
  if (/\b(pothole|blocked|flood|flooded|bad road|motorway|tarmac|gutter|ditch)\b/.test(t)) return 'road_condition';
  if (!cap.trim()) return 'vehicle';
  return 'road_condition';
}

function askRoadWhere(to, s, extra) {
  setAwaitingRoadWhere(s, { ...(extra || {}), step: 'where' }, false);
  const seen = extra && extra.kind === 'accident' ? 'an accident' : 'a road condition';
  const named = extra && extra.road && extra.road !== 'unspecified road' ? ` — *${extra.road}*` : '';
  return wa.locationRequest(to,
    `Photo saved${named} as ${seen}. WhatsApp photos have no GPS — the image has no location metadata.\n\n*Where are you?* Share your location so other riders are not stranded on this stretch.\n\nIf you would rather not, say *no* and type the road or landmark.`);
}

function askRoadWhereTyped(to, s) {
  const waiting = awaitingRoadWhere(s) || {};
  setAwaitingRoadWhere(s, { ...waiting, step: 'where' }, true);
  return wa.text(to,
    'Type the road, junction, or landmark. WhatsApp photos have no GPS — we need you to say where, so other riders are not stranded.');
}

function askRoadKind(to, s, extra) {
  setAwaitingRoadWhere(s, { ...(extra || {}), step: 'kind' }, false);
  return wa.buttons(to,
    'Photo saved. Is this a *road condition* or an *accident*? Then I will ask where you are — the image has no location.',
    [
      { id: 'photo:kind:road_condition', title: 'Road condition' },
      { id: 'photo:kind:accident', title: 'Accident' },
      { id: 'photo:kind:skip', title: 'Skip' }
    ]);
}

function askContractor(to, s, extra) {
  setAwaitingRoadWhere(s, { ...(extra || {}), step: 'contractor' }, true);
  return wa.text(to,
    'If you know the contractor on this stretch, type the name so other riders can see it on ghfares.com/roads.\n\nSay *skip* if you do not know.');
}

async function finishRoadWhere(from, hash, s, place) {
  const waiting = awaitingRoadWhere(s) || {};
  const where_text = place.where_text || '';
  await api.attachRoadWhere({
    photo_id: waiting.photo_id,
    report_id: waiting.report_id,
    lat: place.lat,
    lng: place.lng,
    where_text,
    photo_kind: waiting.kind,
    road: waiting.road
  });
  if ((waiting.kind || 'road_condition') === 'road_condition') {
    return askContractor(from, s, {
      photo_id: waiting.photo_id,
      report_id: waiting.report_id,
      kind: waiting.kind,
      where_text,
      road: waiting.road
    });
  }
  clearAwaitingRoadWhere(s);
  const loc = where_text ? ` at *${where_text}*` : '';
  return wa.buttons(from,
    `Logged${loc}. Other riders can see this on ghfares.com/roads so they are not stranded.\n\nSend *MY PHOTOS* for your history.`,
    [{ id: 'ask:road', title: 'Road conditions' }, { id: 'menu', title: 'Main menu' }]);
}

async function finishContractor(from, s, name) {
  const waiting = awaitingRoadWhere(s) || {};
  clearAwaitingRoadWhere(s);
  const contractor = String(name || '').trim();
  if (contractor) {
    await api.attachRoadWhere({
      photo_id: waiting.photo_id,
      report_id: waiting.report_id,
      contractor,
      photo_kind: waiting.kind || 'road_condition',
      road: waiting.road
    });
  }
  const loc = waiting.where_text ? ` at *${waiting.where_text}*` : '';
  const who = contractor ? `\nContractor: *${contractor}*.` : '';
  return wa.buttons(from,
    `Logged${loc}.${who}\n\nOther riders can see this on ghfares.com/roads so they are not stranded or lost.\n\nSend *MY PHOTOS* for your history.`,
    [{ id: 'ask:road', title: 'Road conditions' }, { id: 'menu', title: 'Main menu' }]);
}

function pinWhereText(location) {
  const lat = Number(location && location.latitude);
  const lng = Number(location && location.longitude);
  const near = (Number.isFinite(lat) && Number.isFinite(lng)) ? api.stationsNear(lat, lng) : { station: null };
  if (near.station && !near.too_far) return 'near ' + near.station.name;
  if (Number.isFinite(lat) && Number.isFinite(lng)) return `pin ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  return 'shared location';
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
  { command_name: 'country',   command_description: 'Set country — share WhatsApp location, or type it' },
  { command_name: 'where',     command_description: 'Find my station and every fare from it' },
  { command_name: 'fare',      command_description: 'Check a fare — send from and to, or share location' },
  { command_name: 'fuel',      command_description: 'Cheapest fuel near me, or compare two areas' },
  { command_name: 'roads',     command_description: 'Road conditions — or send a photo to report' },
  { command_name: 'addfuel',   command_description: 'Add fuel watch — prices and change alerts' },
  { command_name: 'addroute',  command_description: 'Save my daily route' },
  { command_name: 'addroads',  command_description: 'Add road alerts on routes I use' },
  { command_name: 'myaddons',  command_description: 'See and change what is switched on' },
  { command_name: 'myphotos',  command_description: 'See my saved road photos and reports' },
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
  country: 'change country', where: 'where', fare: 'fare', fuel: 'fuel near me', roads: 'road conditions',
  addfuel: 'add fuel', addroute: 'add my route', addroads: 'add roads',
  addqueue: 'add queue', addchart: 'add chart', addreport: 'add report',
  myaddons: 'my addons', myphotos: 'my road photos', help: 'help', stop: 'stop', menu: 'menu'
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
  if (['fare', 'fuel', 'roads', 'where', 'help', 'country'].includes(cmd)) return rest;
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
  s.welcomedAt = Date.now();
  if (!s.country) return [askCountry(to, s)];
  if (!countries.isLive(s.country)) return [noCountryData(to, s, countries.get(s.country))];
  s.onboarded = true;
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
\u2022 *MY PHOTOS* — your saved road reports and images

*Keywords*
\u2022 *MENU* \u2014 everything I can do
\u2022 *WHERE* \u2014 find your station
\u2022 *ADD FUEL / ROADS / MY ROUTE / QUEUE / CHART / REPORT / MY LOCATION*
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

function replyText(payload) {
  if (!payload) return '';
  if (payload.text && payload.text.body) return payload.text.body;
  if (payload.interactive && payload.interactive.body && payload.interactive.body.text) return payload.interactive.body.text;
  return '';
}

function placeName(id) {
  const st = api.station(id);
  return (st && st.name) || String(id || '');
}

function askRouteFollowUp(from, mentioned) {
  const lines = [];
  if (!mentioned.fromId) lines.push(`Which place do you mean by *${mentioned.fromText}*?`);
  else lines.push(`From *${placeName(mentioned.fromId)}*.`);
  if (!mentioned.toId) lines.push(`Which place do you mean by *${mentioned.toText}*?`);
  else lines.push(`To *${placeName(mentioned.toId)}*.`);
  if (!mentioned.fromId) {
    lines.push(`Share your location and I will use the nearest *${mentioned.fromText}* to where you are now. Then tell me the *${mentioned.toText}*. Or type both stations, for example *Kaneshie to Circle*.`);
    return wa.locationRequest(from, lines.join('\n\n'));
  }
  lines.push('Reply with the station name, or both, for example *Kaneshie to Circle*.');
  return wa.text(from, lines.join('\n\n'));
}

function fareReportReplies(from, r) {
  const peers = r.peers || [];
  const author = r.lone
    ? wa.text(from, `Logged *${money(r.logged)}* for ${r.station} → ${r.dest}.\n\nYou are the only rider at this station right now. I saved it as unverified and I will not show a percentage until someone else here agrees.`)
    : wa.text(from, `Logged *${money(r.logged)}* for ${r.station} → ${r.dest}.\n\nI asked *${peers.length}* rider${peers.length === 1 ? '' : 's'} at this station. It stays unverified until two of them agree. No percentage yet.`);
  const asks = peers.map(p => wa.buttons(p.reach,
    `A rider at *${r.station}* reported *${money(r.logged)}* to *${r.dest}* (chart ${money(r.chart)}). Does that match what you pay?`,
    [{ id: `verify:yes:${r.reportId}`, title: 'Yes, it matches' }, { id: `verify:no:${r.reportId}`, title: 'No' }]));
  return [author, ...asks];
}

function continueOpenRouteFromPin(from, hash, open, location) {
  if (open.naming) {
    const park = api.nearestFareStation(location.latitude, location.longitude);
    if (!park) {
      return [wa.text(from, `I do not have a fare station within 8 km of that pin, so I cannot attach *${open.naming}* yet.`)];
    }
    caps.subscriber(hash).station = park.id;
    const pending = crowd.pendingName(open.naming);
    const row = pending && pending.stationId === park.id && pending.hash !== hash
      ? crowd.agreeName(open.naming, park.id, hash)
      : crowd.rememberName(open.naming, park.id, hash);
    return Promise.resolve(row).then(saved => {
      const applied = applyPlaceChoice(open, open.picking === 'to' ? 'to' : 'from', { id: park.id, name: park.name, kind: 'station', lat: park.lat, lng: park.lng });
      const note = saved && saved.status === 'agreed'
        ? `*${open.naming}* now means *${park.name}*.`
        : `*${open.naming}* is pending for *${park.name}*. Another rider at this station has to agree before everyone can use that name.`;
      const next = { ...applied.next, naming: null };
      return finishOpenRoute(from, hash, next, note);
    });
  }
  const phrase = open.fromText;
  const near = api.nearestMatchingPlaces(location.latitude, location.longitude, phrase, 8000);
  if (!near.length) {
    const farther = api.nearestMatchingPlaces(location.latitude, location.longitude, phrase, 40000);
    const hint = farther[0]
      ? `That pin is ${Math.max(1, Math.round(farther[0].metres / 1000))} km from *${farther[0].name}*, so I will not guess the *${phrase}*.`
      : `I do not see a *${phrase}* near that pin.`;
    return [wa.text(from, `${hint}\n\nType the station, or share your location again when you are closer.`)];
  }
  const second = near[1];
  const clear = near[0].metres <= 400 && (!second || second.metres - near[0].metres >= 200);
  const only = near.length === 1 || near[0].metres <= 8000 && (!second || second.metres > 8000);
  if (clear || only) {
    const applied = applyPlaceChoice(open, 'from', near[0]);
    const note = `You're about ${near[0].metres} m from *${near[0].name}*.${applied.note ? '\n\n' + applied.note : ''}`;
    return finishOpenRoute(from, hash, applied.next, note);
  }
  const next = {
    ...open,
    picking: 'from',
    fromText: phrase,
    options: near.map(c => ({ id: c.id, name: c.name, kind: c.kind, lat: c.lat, lng: c.lng }))
  };
  memory.setThread(hash, next);
  lastParse = { intent: 'fare', places: [next.fromId, next.toId].filter(Boolean), via: 'memory' };
  const rows = near.map(c => ({
    id: `mem:from:${c.kind}:${c.id}`,
    title: c.name,
    description: c.metres < 1000 ? `${c.metres} m from you` : `${(c.metres / 1000).toFixed(1)} km from you`
  }));
  return [wa.list(from,
    `That pin is near more than one *${phrase}*. Pick the one you are at. I still need *${open.toText}* after that.`,
    'Choose place',
    listSections(rows, 'Nearby'))];
}

function fareAsk(text) {
  return /\b(fare|fate|how much|cost|price|charge)\b/i.test(String(text || ''));
}

function missingSlot(thread) {
  if (!thread.fromId) return 'from';
  if (!thread.toId) return 'to';
  return null;
}

function applyPlaceChoice(thread, slot, choice) {
  const next = { ...thread, picking: null };
  if (choice.kind === 'stop') {
    const near = api.nearestFareStation(choice.lat, choice.lng);
    if (!near) {
      return { next, note: `*${choice.name}* is on the map as a stop, and I do not have a fare station within 8 km of it.` };
    }
    const id = near.id;
    const label = near.name;
    if (slot === 'to') { next.toId = id; next.toText = label; }
    else { next.fromId = id; next.fromText = label; }
    return { next, note: `*${choice.name}* is a stop. The nearest station I can price is *${label}*.` };
  }
  if (slot === 'to') { next.toId = choice.id; next.toText = choice.name; }
  else { next.fromId = choice.id; next.fromText = choice.name; }
  return { next, note: '' };
}

function askRouteRemaining(from, mentioned, note) {
  const lines = [];
  if (note) lines.push(note);
  if (!mentioned.fromId) lines.push(`Which place do you mean by *${mentioned.fromText}*?`);
  else if (!note) lines.push(`From *${placeName(mentioned.fromId)}*.`);
  if (!mentioned.toId) lines.push(`Which place do you mean by *${mentioned.toText}*?`);
  else lines.push(`To *${placeName(mentioned.toId)}*.`);
  lines.push('Reply with the station name, or both, for example *Kaneshie to Circle*.');
  return wa.text(from, lines.join('\n\n'));
}

function offerPlaceChoices(from, mentioned, slot, choices) {
  const said = slot === 'to' ? mentioned.toText : mentioned.fromText;
  const rows = choices.map(c => ({
    id: `mem:${slot}:${c.kind}:${c.id}`,
    title: c.name,
    description: c.kind === 'stop' ? 'Stop on the map' : 'Station'
  }));
  const still = slot === 'from' && !mentioned.toId
    ? ` I still need *${mentioned.toText}* after you pick.`
    : '';
  return wa.list(from,
    `*${said}* matches more than one place. Pick the one you mean.${still}`,
    'Choose place',
    listSections(rows, 'Places'));
}

function finishOpenRoute(from, hash, next, note) {
  if (next.fromId) caps.subscriber(hash).station = next.fromId;
  if (next.fromId && next.toId) {
    memory.setThread(hash, null);
    lastParse = { intent: 'fare', places: [next.fromId, next.toId], via: 'memory' };
    const fare = answerFare(from, hash, next.fromId, next.toId);
    if (!note) return [fare];
    const body = replyText(fare);
    if (fare.interactive && fare.interactive.body) {
      fare.interactive.body.text = note + '\n\n' + body;
    } else if (fare.text) {
      fare.text.body = note + '\n\n' + body;
    }
    return [fare];
  }
  memory.setThread(hash, next);
  lastParse = { intent: 'fare', places: [next.fromId, next.toId].filter(Boolean), via: 'memory' };
  return [askRouteRemaining(from, next, note)];
}

async function continueOpenRoute(from, hash, text) {
  const open = memory.thread(hash);
  if (!open || open.intent !== 'fare') return null;
  const low = String(text || '').trim().toLowerCase();
  if (/^(hi|hello|hey|menu|help|stop|cancel)$/.test(low) || /^(add|remove|my addons)\b/.test(low)) {
    memory.setThread(hash, null);
    return null;
  }
  if (/\b(road|fuel|petrol|diesel|queue)\b/.test(low) && !fareAsk(low)) {
    memory.setThread(hash, null);
    return null;
  }
  if (open.picking === 'from' && !open.fromId) {
    const town = exactPlace(text);
    if (town) {
      const st = api.station(town);
      const applied = applyPlaceChoice(open, 'to', { id: town, name: (st && st.name) || text, kind: 'station', lat: st && st.lat, lng: st && st.lng });
      const nextTown = { ...applied.next, picking: 'from', options: open.options || null, naming: open.naming || null };
      memory.setThread(hash, nextTown);
      lastParse = { intent: 'fare', places: [nextTown.toId].filter(Boolean), via: 'memory' };
      const rows = (open.options || []).map(c => ({
        id: `mem:from:${c.kind}:${c.id}`,
        title: c.name,
        description: 'Barrier still open'
      }));
      if (rows.length) {
        return [wa.list(from,
          `*${(st && st.name) || text}* is the town. Pick the barrier you are at.`,
          'Choose place',
          listSections(rows, 'Nearby'))];
      }
      return [wa.text(from, `*${(st && st.name) || text}* is the town. The barrier is still open — share your location or name it.`)];
    }
  }
  let next = { ...open, picking: null };
  const mentioned = routeMention(text);
  const shortSide = side => side && side.split(' ').length <= 4 && !/\b(what|how|much|current|fare|please|want)\b/.test(side);
  if (mentioned && (mentioned.fromId || mentioned.toId || (shortSide(mentioned.fromText) && shortSide(mentioned.toText)))) {
    next = { intent: 'fare', fromText: mentioned.fromText, toText: mentioned.toText, fromId: mentioned.fromId, toId: mentioned.toId };
    return finishOpenRoute(from, hash, next, '');
  }
  const slot = missingSlot(next);
  const phrase = String(text || '').trim();
  const pend = crowd.pendingName(phrase);
  if (pend && caps.subscriber(hash).station === pend.stationId && pend.hash !== hash) {
    await crowd.agreeName(phrase, pend.stationId, hash);
  }
  const one = exactPlace(phrase);
  if (one) {
    const st = api.station(one);
    const applied = applyPlaceChoice(next, slot, { id: one, name: (st && st.name) || phrase, kind: 'station', lat: st && st.lat, lng: st && st.lng });
    return finishOpenRoute(from, hash, applied.next, applied.note);
  }
  const choices = api.placeChoices(phrase);
  const exactName = choices.filter(c => c.name.toLowerCase() === phrase.toLowerCase());
  const pick = exactName.length === 1 ? exactName[0] : (choices.length === 1 ? choices[0] : null);
  if (pick) {
    const applied = applyPlaceChoice(next, slot, pick);
    return finishOpenRoute(from, hash, applied.next, applied.note);
  }
  if (choices.length > 1) {
    if (slot === 'to') next.toText = phrase;
    else next.fromText = phrase;
    next.picking = slot;
    next.options = choices.map(c => ({ id: c.id, name: c.name, kind: c.kind, lat: c.lat, lng: c.lng }));
    memory.setThread(hash, next);
    lastParse = { intent: 'fare', places: [next.fromId, next.toId].filter(Boolean), via: 'memory' };
    return [offerPlaceChoices(from, next, slot, choices)];
  }
  if (slot === 'to') next.toText = phrase;
  else next.fromText = phrase;
  next.naming = phrase;
  next.picking = slot;
  memory.setThread(hash, next);
  lastParse = { intent: 'fare', places: [next.fromId, next.toId].filter(Boolean), via: 'memory' };
  return [wa.locationRequest(from, `I do not have *${phrase.replace(/\*/g, '')}* on the map.\n\nShare where you are and I will attach that name to the nearest station. It stays pending until another rider there agrees.`)];
}

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
  if (from) s.reach = from;
  const deleting = text && (/^delete my data$/i.test(String(text).trim()) || /^forget me$/i.test(String(text).trim()));
  if (!deleting) {
    await memory.hydrate(hash);
    if (text) await memory.remember(hash, 'in', text, null);
    else if (location) await memory.remember(hash, 'in', 'shared a location', 'where');
  }
  let payloads;
  try {
    payloads = await dispatch({ from, hash, text, interactiveId, location, type, s, image });
  } finally {
    await caps.flush(hash, channel);
  }
  payloads = withLocationChoices(from, hash, payloads, channel);
  payloads = withSignals(from, payloads);
  if (!deleting) {
    const body = (payloads || []).map(replyText).filter(Boolean).join('\n');
    if (body) await memory.remember(hash, 'out', body, lastParse.intent);
  }
  return payloads;
}

function withLocationChoices(from, hash, payloads, channel) {
  const list = Array.isArray(payloads) ? payloads : (payloads ? [payloads] : []);
  const asks = list.some(p => p && p.interactive && p.interactive.type === 'location_request_message');
  if (!asks || list.some(p => /\/loc\//.test(replyText(p)))) return list;
  const token = locationLink.issue({ hash, from, channel: channel || 'whatsapp' });
  const url = locationLink.siteBase() + '/loc/' + token;
  return list.concat(wa.text(from,
    '*Or use another way*\n\n*Browser* — open this link and allow location. I will answer back in this chat:\n' + url +
    '\n\n*Type it* — send the station or the route, for example *Kaneshie to Circle*.'));
}

function withSignals(from, payloads) {
  const list = Array.isArray(payloads) ? payloads : (payloads ? [payloads] : []);
  if (list.some(p => p && p.interactive && p.interactive.action && p.interactive.action.buttons && p.interactive.action.buttons.some(b => b.reply && String(b.reply.id).startsWith('sig:')))) return list;
  if (!list.some(p => /Estimated fare|Approved fare/.test(replyText(p)))) return list;
  return list.concat(wa.buttons(from, 'Was this reply useful? A like or dislike does not change the fare.', [
    { id: 'sig:up', title: 'Like' },
    { id: 'sig:down', title: 'Dislike' }
  ]));
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

  let logged = r.stored || !r.neon
    ? `Photo saved — *${road}* as ${condition}.`
    : `I received the photo of *${road}* as ${condition}.`;
  const kind = inferPhotoKind(r.check, caption, condition);
  await api.setRoadKind({ photo_id: r.photo_id, report_id: r.report_id, photo_kind: kind, road });
  const extra = { photo_id: r.photo_id, report_id: r.report_id, kind, road, condition, note: logged };

  if (kind === 'vehicle' || kind === 'not_road') {
    return askRoadKind(from, s, extra);
  }
  return askRoadWhere(from, s, extra);
}

async function answerRoadHistory(to, hash) {
  const rows = await api.roadPhotoHistory(hash);
  if (!rows.length) {
    return wa.text(to,
      'You have no road photos yet. Send one from WhatsApp — I will check it, save it on your history, and key the report to that image.');
  }
  const lines = rows.slice(0, 8).map(r => {
    const check = r.check_accurate === true ? 'looks right' : r.check_accurate === false ? 'unclear photo' : 'saved';
    const key = r.report_id ? `report #${r.report_id} ↔ photo #${r.id}` : `photo #${r.id}`;
    const where = r.where_text ? ` · ${r.where_text}` : '';
    return `• *${r.road}* — ${r.condition || 'condition'} · ${check} · ${key}${where}`;
  });
  return wa.buttons(to,
    `*Your road photos*\n\n${lines.join('\n')}\n\nEach report is keyed to its image. Send another WhatsApp photo to add one.`,
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
    hash,
    photo_kind: condition === 'accident' ? 'accident' : 'road_condition'
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

  if (text && (/^delete my data$/i.test(String(text).trim()) || /^forget me$/i.test(String(text).trim()))) {
    caps.forget(hash);
    return [wa.text(from, 'Your GH Fares data for this chat is deleted — add-ons, saved station, route, country, road photos, and the memory of this chat. Message history inside WhatsApp or Messenger is still held by Meta. Send *hi* if you want to start again.')];
  }

  if (!s.country && s.context && s.context.country) s.country = s.context.country;
  if (!s.awaitingCountry && s.context && s.context.awaitingCountry) s.awaitingCountry = s.context.awaitingCountry;
  if (!s.awaitingRoadWhere && s.context && s.context.awaitingRoadWhere) s.awaitingRoadWhere = s.context.awaitingRoadWhere;

  /* Meta fires this when someone opens a chat with no existing thread.
     It also opens the service window, so we may reply free-form. */
  if (type === 'request_welcome') return welcome(from, hash);

  if (interactiveId && String(interactiveId).startsWith('country:')) {
    const code = String(interactiveId).split(':')[1];
    if (code === 'ask') return [askCountry(from, s)];
    const row = setCountry(s, code);
    return [afterCountry(from, hash, s, row)];
  }

  if (text) {
    const ice = ICE_MAP[String(text).trim().toLowerCase()];
    if (ice) text = ice;
    else if (String(text).trim().startsWith('/')) text = expandCommand(text);
    if (countries.wantsSwitch(text)) {
      const row = countries.resolve(text);
      if (row) {
        setCountry(s, row.iso);
        return [afterCountry(from, hash, s, row)];
      }
      s.country = null;
      return [askCountry(from, s)];
    }
  }

  if (!s.country || awaitingCountry(s)) {
    if (location) {
      const row = applyCountryFromCoords(s, location.latitude, location.longitude);
      if (!row) {
        setAwaitingCountry(s, true);
        return [wa.text(from, 'I could not tell the country from that pin. Type the country, or share your WhatsApp location again.')];
      }
      if (!countries.isLive(row.iso)) return [noCountryData(from, s, row)];
      s.onboarded = true;
      const near = api.stationsNear(location.latitude, location.longitude);
      if (near.station && !near.too_far) {
        return [finishPlace(from, hash, s, { places: [near.station.id], metres: near.metres })];
      }
      return [startMenu(from, hash)];
    }
    if (interactiveId && String(interactiveId).split(':')[0] === 'place') {
      return [askCountryTyped(from, s)];
    }
    if (text) {
      if (isPlaceDecline(text)) return [askCountryTyped(from, s)];
      const row = countries.resolve(text);
      if (row) {
        setCountry(s, row.iso);
        return [afterCountry(from, hash, s, row)];
      }
      if (awaitingCountry(s) && ((s.awaitingCountry || (s.context && s.context.awaitingCountry) || {}).typed)) {
        return [wa.text(from, 'We don\'t have data for that country yet. Share your WhatsApp location, or type another country.')];
      }
      return [askCountry(from, s)];
    }
    return [askCountry(from, s)];
  }

  if (!liveCountry(s)) {
    if (location) {
      const row = applyCountryFromCoords(s, location.latitude, location.longitude);
      if (row) return [afterCountry(from, hash, s, row)];
      setAwaitingCountry(s, true);
      return [wa.text(from, 'I could not tell the country from that pin. Type the country, or share your WhatsApp location again.')];
    }
    if (text) {
      if (isPlaceDecline(text)) return [askCountryTyped(from, s)];
      const row = countries.resolve(text);
      if (row) {
        setCountry(s, row.iso);
        return [afterCountry(from, hash, s, row)];
      }
    }
    return [noCountryData(from, s, countries.get(s.country))];
  }

  if (image || type === 'image') return [await handleRoadPhoto(from, hash, image || {}, s)];

  /* location share → road-photo place first (images have no GPS), then an open fare, then nearest station */
  if (location) {
    const openFare = memory.thread(hash);
    if (openFare && openFare.intent === 'fare' && !openFare.fromId) {
      return continueOpenRouteFromPin(from, hash, openFare, location);
    }
    const waitingRoad = awaitingRoadWhere(s);
    if (waitingRoad && waitingRoad.step !== 'kind') {
      return [await finishRoadWhere(from, hash, s, {
        lat: location.latitude,
        lng: location.longitude,
        where_text: pinWhereText(location)
      })];
    }
    const waiting = awaitingPlace(s);
    const reason = (waiting && waiting.reason) || 'station';
    const near = api.stationsNear(location.latitude, location.longitude);
    const limit = waiting ? 80000 : 25000;
    if (!near.station || near.metres == null || near.metres > limit) {
      const km = near.metres != null ? Math.round(near.metres / 1000) : null;
      const hint = near.station && km != null
        ? `That pin is about ${km} km from the nearest mapped station (*${near.station.name}*). `
        : '';
      setAwaitingPlace(s, reason, true);
      return [wa.text(from, hint + 'Type the station name, or share again when you are at a station in this country.')];
    }
    return [finishPlace(from, hash, s, { places: [near.station.id], metres: near.metres })];
  }

  /* interactive taps */
  if (interactiveId) {
    const p = interactiveId.split(':');
    if (p[0] === 'sig') {
      await crowd.signal(hash, p[1] === 'down' ? 'down' : 'up', lastParse.intent);
      const mine = crowd.score(hash);
      return [wa.text(from, `Noted. You are a *${mine.tier}*. A like or dislike does not change the fare.`)];
    }
    if (p[0] === 'verify') {
      const row = await crowd.vote(p[2], hash, p[1] === 'yes');
      if (!row) return [wa.text(from, 'That check has expired.')];
      if (row.status === 'agreed') {
        if (row.kind === 'fare') {
          const agreed = await crowd.history(row.routeKey);
          const avg = agreed.reduce((sum, item) => sum + Number(item.amount), 0) / (agreed.length || 1);
          const pct = row.chart ? Math.round(((avg - row.chart) / row.chart) * 1000) / 10 : 0;
          api.core.gouging[row.routeKey] = {
            avg_reported: Math.round(avg * 100) / 100,
            chart: row.chart,
            pct,
            reports: agreed.length,
            agreed: true
          };
        }
        if (row.kind === 'queue') {
          api.core.queues[row.routeKey] = {
            state: row.detail,
            at: new Date().toISOString(),
            pings: row.agrees.length,
            agreed: true
          };
        }
        if (row.kind === 'road') {
          const inc = api.core.incidents.find(i => i.id === row.dest);
          if (inc) inc.confirmations = row.agrees.length;
        }
        const mine = crowd.score(hash);
        return [wa.text(from, `Agreed. Riders at this station can see it now.\n\nYou are a *${mine.tier}* with *${mine.points}* points. The tier does not change the fare.`)];
      }
      if (row.status === 'contradicted') return [wa.text(from, 'That report was contradicted. It will not be shown as a percentage.')];
      return [wa.text(from, 'Noted. Still waiting for two riders at this station to agree.')];
    }
    if (p[0] === 'mem') {
      const open = memory.thread(hash);
      if (!open) return [wa.text(from, 'That choice expired. Send the route again, for example *Kaneshie to Circle*.')];
      const slot = p[1] === 'to' ? 'to' : 'from';
      const kind = p[2];
      const id = p.slice(3).join(':');
      let choice = null;
      if (kind === 'stop') {
        const stop = api.core.stops && api.core.stops[id];
        if (stop) choice = { id: stop.id, name: stop.name, kind: 'stop', lat: stop.lat, lng: stop.lng };
      } else {
        const st = api.station(id);
        if (st) choice = { id: st.id, name: st.name, kind: 'station', lat: st.lat, lng: st.lng };
      }
      if (!choice) return [wa.text(from, 'That place is not on the map anymore. Name the station.')];
      const applied = applyPlaceChoice(open, slot, choice);
      return finishOpenRoute(from, hash, applied.next, applied.note);
    }
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
        const label = `${r.station || p[1]} → ${r.dest || p[2]}: ${p[3]}`;
        if (r.lone) {
          return [wa.text(from, `Logged — *${label}*.\n\nYou are the only rider at this station right now, so this queue stays unverified.`)];
        }
        const asks = (r.peers || []).map(peer => wa.buttons(peer.reach,
          `A rider at *${r.station || 'this station'}* says the queue to *${r.dest || p[2]}* is *${p[3]}*. Does that match?`,
          [{ id: `verify:yes:${r.reportId}`, title: 'Yes, it matches' }, { id: `verify:no:${r.reportId}`, title: 'No' }]));
        return [wa.text(from, `Logged — *${label}*.\n\nI asked *${r.peers.length}* rider${r.peers.length === 1 ? '' : 's'} at this station. It stays unverified until two of them agree.`), ...asks]; }
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
        const stationId = caps.subscriber(hash).station;
        if (!stationId) {
          return [wa.text(from, `*${inc.road}* stays unverified until two other riders at your station agree. Tell me the station you are at first.`)];
        }
        const filed = await crowd.fileReport({ kind: 'road', stationId, dest: inc.id, hash, detail: inc.road });
        if (filed.lone) {
          return [wa.text(from, `*${inc.road}* is unverified. You are the only rider at this station right now, so I will not add a confirmation count.`)];
        }
        const asks = filed.peers.map(peer => wa.buttons(peer.reach,
          `A rider at your station says *${inc.road}* is still blocked. Does that match?`,
          [{ id: `verify:yes:${filed.id}`, title: 'Yes, it matches' }, { id: `verify:no:${filed.id}`, title: 'No' }]));
        return [wa.text(from, `I asked *${filed.peers.length}* rider${filed.peers.length === 1 ? '' : 's'} about *${inc.road}*. It stays unverified until two of them agree.`), ...asks];
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
    if (p[0] === 'photo' && p[1] === 'kind') {
      const waiting = awaitingRoadWhere(s) || {};
      const kind = p[2];
      if (kind === 'skip') {
        clearAwaitingRoadWhere(s);
        await api.setRoadKind({ photo_id: waiting.photo_id, report_id: waiting.report_id, photo_kind: 'not_road', road: waiting.road });
        return [wa.buttons(from,
          'Skipped. The photo is on your history — send *MY PHOTOS*. It will not go on the public roads list.',
          [{ id: 'menu', title: 'Main menu' }])];
      }
      await api.setRoadKind({ photo_id: waiting.photo_id, report_id: waiting.report_id, photo_kind: kind, road: waiting.road });
      return [askRoadWhere(from, s, { ...waiting, kind })];
    }
    if (p[0] === 'loc') {
      if (awaitingRoadWhere(s)) return [askRoadWhere(from, s, awaitingRoadWhere(s))];
      return [askPlace(from, s, 'station')];
    }
    if (p[0] === 'place') {
      if (awaitingRoadWhere(s)) return [askRoadWhereTyped(from, s)];
      return [askPlaceTyped(from, s, (awaitingPlace(s) && awaitingPlace(s).reason) || 'station')];
    }
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

  /* Conversational Components arrive as text — slash and ice already expanded. */

  if (text && awaitingRoadWhere(s)) {
    const waiting = awaitingRoadWhere(s);
    const raw = String(text).trim();
    const low = raw.toLowerCase();
    if (waiting.step === 'kind') {
      if (isPlaceDecline(raw) || /^(skip|neither)$/i.test(raw)) {
        clearAwaitingRoadWhere(s);
        await api.setRoadKind({ photo_id: waiting.photo_id, report_id: waiting.report_id, photo_kind: 'not_road', road: waiting.road });
        return [wa.buttons(from,
          'Skipped. The photo is on your history — send *MY PHOTOS*.',
          [{ id: 'menu', title: 'Main menu' }])];
      }
      const kind = /\b(accident|crash|collision|wreck)\b/.test(low) ? 'accident'
        : /\b(road|condition|pothole|block|flood)\b/.test(low) ? 'road_condition'
        : null;
      if (!kind) return [askRoadKind(from, s, waiting)];
      await api.setRoadKind({ photo_id: waiting.photo_id, report_id: waiting.report_id, photo_kind: kind, road: waiting.road });
      return [askRoadWhere(from, s, { ...waiting, kind })];
    }
    if (waiting.step === 'contractor') {
      if (isPlaceDecline(raw) || /^(skip|none|n\/a|na|don't know|dont know|unknown|no idea)$/i.test(low)) {
        return [await finishContractor(from, s, '')];
      }
      return [await finishContractor(from, s, raw)];
    }
    if (isPlaceDecline(raw)) return [askRoadWhereTyped(from, s)];
    return [await finishRoadWhere(from, hash, s, { where_text: raw })];
  }

  if (text && awaitingPlace(s)) {
    const placed = await handleTypedPlace(from, hash, s, text);
    if (placed) return placed;
  }

  if (text) {
    const continued = await continueOpenRoute(from, hash, text);
    if (continued) return continued;
  }

  const prior = memory.recent(hash).filter((m, i, arr) => !(i === arr.length - 1 && m.direction === 'in' && m.body === String(text || '').trim()));
  const c = await classify(text, { memory: prior });
  lastParse = c;

  /* pending fare amount */
  if (s.pending && c.amount != null) {
    const r = await api.reportFare(s.pending.from, s.pending.to, c.amount, hash);
    s.pending = null;
    if (!r) return [wa.text(from, 'Could not log that one.')];
    return fareReportReplies(from, r);
  }

  /* quick-report add-on: a bare number with a saved route needs no context.
     Must run before the switch — the classifier defaults bare numbers to menu. */
  if (c.amount != null && /^[\d.\s₵]+$/.test(String(text || '')) &&
      caps.granted(hash, 'report.fast') && s.route) {
    const r = await api.reportFare(s.route.from, s.route.to, c.amount, hash);
    if (r) return fareReportReplies(from, r);
  }

  if (text && (c.intent === 'fare' || fareAsk(text))) {
    const mentioned = routeMention(text);
    if (mentioned && (!mentioned.fromId || !mentioned.toId)) {
      const open = { intent: 'fare', fromText: mentioned.fromText, toText: mentioned.toText, fromId: mentioned.fromId, toId: mentioned.toId };
      memory.setThread(hash, open);
      lastParse = { intent: 'fare', places: [open.fromId, open.toId].filter(Boolean), via: 'memory' };
      return [askRouteFollowUp(from, open)];
    }
  }

  switch (c.intent) {
    case 'addon_add': return [addonAdd(from, hash, c.arg)];
    case 'addon_remove': return [addonRemove(from, hash, c.arg)];
    case 'addon_list': return [addonList(from, hash)];
    case 'greet':
    case 'menu':
      if (c.intent === 'greet' && s.onboarded && liveCountry(s) && s.welcomedAt && Date.now() - s.welcomedAt < 2 * 60 * 1000) {
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
    case 'road_history': return [await answerRoadHistory(from, hash)];
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
