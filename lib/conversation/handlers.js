/**
 * Domain handlers for the conversation graph. Each builds the reply for one
 * kind of answer — a fare, a fuel card, a road report, a menu — from the
 * recorded data. They do not decide which answer to give; the graph's edges
 * do that (lib/conversation/graph.js).
 *
 * Moved out of lib/engine.js unchanged, except that the classification is
 * written to the running ConversationState instead of a shared variable.
 */
const wa = require('../wa');
const caps = require('../capabilities');
const { classify, classifyRegex, api, routeMention, exactPlace, isVaguePlace, atStatement, stopsQuery, legsPassing, stationsServing } = require('../api');
const countries = require('../countries');
const memory = require('../memory');
const crowd = require('../crowd');
const fuelChecks = require('../fuel-checks');
const tools = require('../tools');
const locationLink = require('../location-link');
const dataTable = require('../data-table');
const { setParse, getParse } = require('./state');
const topics = require('../agents/topic');
const voice = require('../agents/voice');

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

/* ══════════════ WHERE ══════════════ */

/* "Where are you?" — typing comes first. Sharing the pin is a button the rider
   may tap, never the only way: most riders do not want to share location. */
const WHERE_BUTTONS = [{ id: 'place', title: '⌨️ Type it' }, { id: 'pin', title: '📍 Share location' }];
const SHARE_LINE = 'Or tap *Share location* if you prefer.';

function whereCard(to, body, extra) {
  return wa.buttons(to, body, extra || WHERE_BUTTONS);
}

/** A reply that asks where the rider is — the where card, or WhatsApp's own location prompt. */
function asksWhere(p) {
  const i = p && p.interactive;
  if (!i) return false;
  if (i.type === 'location_request_message') return true;
  return i.type === 'button' && (i.action.buttons || []).some(b => b.reply && b.reply.id === 'pin');
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
    return whereCard(to,
      `*My location*\n\nTell me where you are — type the station or area, like *Kaneshie*. I only use it to answer this chat.\n\n${SHARE_LINE}`);
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
  if (/^(all|everything|alerts?|messages?|notifications?)$/i.test(String(arg || '').trim())) {
    const on = caps.list(hash).filter(c => c.active);
    for (const c of on) caps.remove(hash, c.id);
    return wa.buttons(to,
      on.length
        ? `Done — all alerts are off (${on.map(c => c.title).join(', ')}). I will only message you when you write to me.`
        : 'You have no alerts on, so I will only message you when you write to me.',
      [{ id: 'addon:menu', title: 'See add-ons' }, { id: 'menu', title: 'Main menu' }]);
  }
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

/**
 * Every fare from one station. `here` is true when the rider is there — a
 * pin, "I am at …", or the answer to "where are you?" — and false when they
 * only named the place, so the board does not tell them where they are.
 */
function answerStationBoard(to, hash, stationId, metres, opts = {}) {
  const r = api.stationFares(stationId);
  if (!r) return askWhereNow(to, caps.subscriber(hash), 'station');
  const here = opts.here != null ? opts.here : metres != null;
  const s = caps.subscriber(hash);
  s.station = stationId;
  topics.station(s, stationId, r.station.name);
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

  const withStops = r.fares.some(f => (f.stops || []).length);
  const stopsHint = withStops ? '\n\nAsk *the stops* for any of these and I will list them.' : '';
  const body = here
    ? `*You're at ${r.station.name}*${metres != null ? ` _(${metres} m)_` : ''}\n\nFrom here trotros go to ${r.fares.length} places. Tap one for the fare and the queue, or to tell me what you paid.${stopsHint}`
    : `${voice.line('station', { name: r.station.name }, hash)}\n\n${r.fares.length} places to choose from. Tap one for the fare and the queue.${stopsHint}`;
  return wa.list(to,
    body,
    'Choose destination',
    listSections(rows, 'Destinations'),
    null,
    estimate ? '2015 survey · estimate, not GPRTU' : 'GPRTU chart'
  );
}

function fareLabel(kind) {
  if (kind === 'composed') return 'COMPOSED';
  if (kind === 'estimated') return 'ESTIMATED';
  return 'REPORTED';
}

function answerComposed(to, plan) {
  const lines = plan.legs.map(l =>
    `${l.fromName} → ${l.toName}  ${money(l.fare)}${l.estimated ? ' est.' : ''}`
  ).join('\n');
  const note = plan.anyEstimate
    ? 'At least one leg is a 2015 survey estimate, not an approved chart. The total is the sum of those table fares, not a new price.'
    : 'Each leg is a fare already in the table. This combination was not recorded as one route.';
  return wa.buttons(to,
    `*COMPOSED*\n\nNo single fare is recorded for this trip.\n\n\`\`\`${lines}\`\`\`\n\nTotal: *${money(plan.total)}*\n\n${note}`,
    [{ id: 'menu', title: 'Main menu' }]);
}

function answerEstimatedRange(to, plan) {
  const span = plan.low === plan.high ? money(plan.total) : `${money(plan.low)}–${money(plan.high)}`;
  return wa.buttons(to,
    `*ESTIMATED*\n\nNo reported legs connect *${plan.fromName}* and *${plan.toName}*.\n\nAbout *${span}* for ${plan.km} km in a straight line, from the typical fare per kilometre in the table (${plan.samples} legs).\n\nThis is not a fare anyone reported. Check at the station.`,
    [{ id: 'menu', title: 'Main menu' }]);
}

function withNote(payload, note) {
  if (!payload || !note) return payload;
  if (payload.interactive && payload.interactive.body && payload.interactive.body.text) {
    payload.interactive.body.text = note + '\n\n' + payload.interactive.body.text;
    return payload;
  }
  if (payload.text && payload.text.body) payload.text.body = note + '\n\n' + payload.text.body;
  return payload;
}

function answerStops(to, mentioned, hash) {
  if (!mentioned || !mentioned.fromText || !mentioned.toText) {
    return wa.text(to, 'Happy to list the stops. Which route — for example *Kasoa to Abossey Okai*?');
  }
  const leg = tools.execute('route_stops', {
    from: mentioned.fromId || mentioned.fromText,
    to: mentioned.toId || mentioned.toText,
    toText: mentioned.toText
  });
  if (!leg || !(leg.names || []).length) {
    const plan = tools.execute('plan_fare', { from: mentioned.fromId || mentioned.fromText, to: mentioned.toId || mentioned.toText });
    if (plan && plan.kind === 'composed' && (plan.legs || []).length > 1) {
      const via = plan.legs.slice(0, -1).map(l => `*${l.toName}*`).join(', ');
      return wa.buttons(to,
        `There's no single car for that trip — you change at ${via}. Ask for the stops on one leg, like *stops ${plan.legs[0].fromName} to ${plan.legs[0].toName}*.`,
        [{ id: `stops:${plan.legs[0].from}:${plan.legs[0].to}`, title: 'First leg stops' }, { id: 'menu', title: 'Main menu' }]);
    }
    return wa.buttons(to, 'Sorry, I do not have the stops for that one stored yet.', [{ id: 'menu', title: 'Main menu' }]);
  }
  if (hash) topics.route(caps.subscriber(hash), leg);
  const lines = leg.names.map((name, i) => `${i + 1}. ${name}`).join('\n');
  return wa.buttons(to,
    `${voice.line('stops', { from: leg.fromName, to: leg.toName }, hash)}\n\n*Stops on ${leg.fromName} → ${leg.toName}*\n\n${lines}\n\nThese are the stops on the recorded leg, in that order. There is no fare for each stop.`,
    [{ id: `fare:${leg.fromId}:${leg.toId}`, title: 'Fare for this route' }, { id: 'menu', title: 'Main menu' }]);
}

/** "does the kasoa car pass sakaman" — yes with the legs, or no. */
function answerPass(to, hash, q) {
  const st = api.station(q.stationId);
  const legs = legsPassing(q.stationId, q.phrase);
  if (!st) return null;
  if (!legs.length) {
    return wa.buttons(to,
      `Not on the routes I have recorded from *${st.name}* — none of them lists *${q.phrase}* as a stop. Drivers sometimes vary, so ask the mate to be sure.`,
      [{ id: `ctx:stops:${st.id}`, title: 'See the routes' }, { id: 'menu', title: 'Main menu' }]);
  }
  topics.route(caps.subscriber(hash), legs[0]);
  const lines = legs.slice(0, 5).map(l => `• *${l.fromName} → ${l.toName}* passes ${l.stopName}`).join('\n');
  return wa.buttons(to,
    `Yes 👍\n\n${lines}`,
    [{ id: `stops:${legs[0].fromId}:${legs[0].toId}`, title: 'All the stops' }, { id: `fare:${legs[0].fromId}:${legs[0].toId}`, title: 'The fare' }]);
}

/** "where do i get car to kasoa" — the stations that load for that destination. */
function answerServed(to, hash, destId) {
  const target = api.station(destId);
  const name = (target && target.name) || placeLabel(destId) || destId;
  const rows = stationsServing(destId).slice(0, 10).map(r => ({
    id: `dest:${r.stationId}:${r.toId}`,
    title: clip(r.stationName, 24),
    description: clip(`to ${r.toName} · ${money(r.chart)}`, 72)
  }));
  if (!rows.length) {
    return wa.buttons(to, `I don't have a station recorded that loads for *${name}* yet. Tell me where you are and I'll check from there.`,
      [{ id: 'loc', title: 'Where I am' }, { id: 'menu', title: 'Main menu' }]);
  }
  return wa.list(to,
    `Cars to *${name}* load at ${rows.length === 1 ? 'this station' : `these ${rows.length} stations`}. Tap one for the fare and the queue.`,
    'Choose station',
    listSections(rows, 'Stations'),
    null,
    '2015 survey · estimate, not GPRTU');
}

/** "where is the kasoa station" — where it is on the map, and what runs from it. */
function answerWhereIs(to, hash, placeId) {
  const st = api.station(placeId);
  if (!st || st.lat == null || st.lng == null) return null;
  const map = `https://maps.google.com/?q=${st.lat},${st.lng}`;
  const runs = (st.fares || []).length ? `\n\nTrotros from there go to ${st.fares.length} places.` : '';
  return wa.buttons(to,
    `*${st.name}*${st.region ? ` · ${st.region}` : ''} is here on the map:\n${map}${runs}`,
    [{ id: `ctx:board:${st.id}`, title: 'Fares from there' }, { id: 'loc', title: 'Where I am' }]);
}

/* Destinations from one station that have stops stored — tap one for the list. */
function stopsPicker(to, hash, stationId) {
  const st = api.station(stationId);
  const legs = ((st && st.fares) || []).filter(f => (f.stops || []).length);
  if (!st) return wa.text(to, 'Happy to list the stops. Which route — for example *Kasoa to Abossey Okai*?');
  if (!legs.length) {
    return wa.buttons(to, `Sorry, I do not have stops stored for the cars from *${st.name}* yet.`,
      [{ id: `ctx:board:${stationId}`, title: 'Fares from here' }, { id: 'menu', title: 'Main menu' }]);
  }
  topics.station(caps.subscriber(hash), st.id, st.name);
  const rows = legs.map(f => ({
    id: `stops:${st.id}:${f.to}`,
    title: clip(f.name, 24),
    description: clip(`${f.stops.length} stops`, 72)
  }));
  return wa.list(to,
    `${voice.line('pickLeg', { name: st.name }, hash)} Tap it and I will list every stop on the way.`,
    'Choose route',
    listSections(rows, 'Destinations'));
}

/**
 * "what stops are along that route", "the stops", "stops to circle", "where e
 * dey stop". A route named in full is answered; otherwise the place named,
 * then what was just shown, decides which leg is meant.
 */
function answerStopsAsk(to, hash, s, text) {
  const mentioned = stopsQuery(text);
  if (mentioned && mentioned.fromText && mentioned.toText) return answerStops(to, mentioned, hash);
  const places = classifyRegex(text).places;
  const topic = topics.get(s);
  const legFrom = (fromId, toId) => {
    const st = api.station(fromId);
    const f = st && (st.fares || []).find(x => x.to === toId);
    return f ? { fromId: st.id, toId: f.to, fromText: st.name, toText: f.name } : null;
  };
  if (places.length === 1) {
    const via = topic && topic.kind === 'station' && legFrom(topic.stationId, places[0]);
    if (via) return answerStops(to, via, hash);
    const viaRoute = topic && topic.kind === 'route' && legFrom(topic.fromId, places[0]);
    if (viaRoute) return answerStops(to, viaRoute, hash);
    if (api.station(places[0])) return stopsPicker(to, hash, places[0]);
  }
  if (topic && topic.kind === 'route') {
    return answerStops(to, { fromId: topic.fromId, toId: topic.toId, fromText: topic.fromName, toText: topic.toName }, hash);
  }
  if (topic && topic.kind === 'station') return stopsPicker(to, hash, topic.stationId);
  return wa.text(to, 'Happy to list the stops. Which route — for example *Kasoa to Abossey Okai*? Or tell me the station you are starting from.');
}

/**
 * The data agent could not tell what a short or informal question means.
 * Ask back with the two or three things it most likely means, instead of
 * guessing or handing it to small talk.
 */
function clarify(to, hash, s, text) {
  const said = String(text || '').trim();
  /* "10" right after a fare — did they pay that? */
  const shown = topics.get(s);
  const amount = /^₵?\s*\d+(\.\d+)?\s*(cedis?|ghs)?$/i.test(said) ? parseFloat(said.replace(/[^\d.]/g, '')) : null;
  if (amount != null && amount > 0 && amount < 1000 && shown && shown.kind === 'route') {
    return wa.buttons(to,
      `Did you pay *₵${amount}* for *${shown.fromName} → ${shown.toName}*?`,
      [
        { id: `paid:${shown.fromId}:${shown.toId}:${amount}`, title: 'Yes, log it' },
        { id: 'menu', title: 'No' }
      ]);
  }
  const hint = said && said.split(/\s+/).length <= 3 ? api.suggestPlace(said.replace(/[?!.]+$/, '')) : null;
  if (hint) {
    return wa.buttons(to, `Did you mean *${hint.name}*?`, [
      { id: `did:${hint.id}`, title: clip(hint.name, 20) },
      { id: 'did:no', title: 'Not that' }
    ]);
  }
  const topic = topics.get(s);
  if (topic && topic.kind === 'station') {
    return wa.buttons(to,
      `Sorry, I didn't get you well. Is this about *${topic.name}*? Pick one, or say it another way.`,
      [
        { id: `ctx:stops:${topic.stationId}`, title: 'Stops on a route' },
        { id: `ctx:board:${topic.stationId}`, title: 'Fares from here' },
        { id: 'menu', title: 'Something else' }
      ]);
  }
  if (topic && topic.kind === 'route') {
    return wa.buttons(to,
      `Sorry, I didn't get you well. Is this about *${topic.fromName} → ${topic.toName}*?`,
      [
        { id: `stops:${topic.fromId}:${topic.toId}`, title: 'The stops' },
        { id: `fare:${topic.fromId}:${topic.toId}`, title: 'The fare' },
        { id: 'menu', title: 'Something else' }
      ]);
  }
  return wa.buttons(to,
    "Sorry, I didn't get you well. Tell me a bit more — like *Kaneshie to Circle*, or *petrol price at Tema*. Or pick one:",
    [
      { id: 'ask:fare', title: 'Check a fare' },
      { id: 'ask:fuel', title: 'Fuel prices' },
      { id: 'ask:road', title: 'Road status' }
    ]);
}

function legNote(name, leg, endpoint) {
  const route = `*${leg.fromName} → ${leg.toName}*`;
  if (endpoint) return `You are at *${name}*. This is the station-to-station fare for ${route}.`;
  return `You are at *${name}* on ${route}.\n\nThis is the station-to-station fare for the whole leg, not a fare from this stop.`;
}

function answerAt(to, hash, s, phrase) {
  const found = tools.execute('at_place', { phrase });
  if (found.kind === 'station') return answerStationBoard(to, hash, found.id, null, { here: true });
  if (found.kind === 'map') {
    if (s.context) delete s.context.atName;
    const where = found.region ? ` · ${found.region}` : '';
    return wa.buttons(to,
      `*${found.name}*${where} is on the map.\n\nI do not have fares from this park yet. Share where you are if you want the nearest park that has a fare.`,
      [{ id: 'loc', title: 'Where I am' }, { id: 'menu', title: 'Main menu' }]);
  }
  if (found.kind === 'stop' && found.legs && found.legs.length === 1) {
    const leg = found.legs[0];
    const fare = answerFare(to, hash, leg.fromId, leg.toId);
    return withNote(fare, legNote(found.name, leg, leg.endpoint));
  }
  if (found.kind === 'stop' && found.legs && found.legs.length > 1) {
    const rows = found.legs.slice(0, 10).map(leg => ({
      id: `stopleg:${leg.fromId}:${leg.toId}:${leg.stopId}`,
      title: clip(leg.toName, 24),
      description: clip(leg.fromName, 72)
    }));
    const endpoint = found.legs.every(leg => leg.endpoint);
    return wa.list(to,
      endpoint
        ? `*${found.name}* is on more than one recorded leg. Pick one. The fare shown is the station-to-station fare for that whole leg.`
        : `*${found.name}* is on more than one route. Pick the leg. The fare is for that whole leg, not from this stop.`,
      'Choose route',
      listSections(rows, 'Routes'));
  }
  s.context = { ...(s.context || {}), atName: phrase };
  return askWhereNow(to, s, 'station', phrase);
}

function answerFare(to, hash, from, to_) {
  const r = api.fare(from, to_);
  if (!r) {
    const fromId = (api.station(from) && api.station(from).id) || from;
    const toId = (api.station(to_) && api.station(to_).id) || to_;
    const plan = tools.execute('plan_fare', { from: fromId, to: toId });
    if (plan && (plan.kind === 'composed' || plan.kind === 'estimated')) {
      topics.route(caps.subscriber(hash), { fromId, toId, fromName: placeLabel(from) || from, toName: placeLabel(to_) || to_ });
    }
    if (plan && plan.kind === 'composed') return answerComposed(to, plan);
    if (plan && plan.kind === 'estimated' && !(plan.legs || []).length) return answerEstimatedRange(to, plan);
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
      `*REPORTED*\n\n*${r.route.from} → ${r.route.to}* · ${r.route.km} km · ${r.route.duration}\n\n\`\`\`${lines}\`\`\`\n\n*Lowest: ${best.operator} ${best.class}, ${money(best.amount)}*${prov(r)}`,
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
  topics.route(caps.subscriber(hash), { fromId: r.from.id, toId: r.to.to, fromName: r.from.name, toName: r.to.name });

  const storedFare = dataTable.fare(r.from.id, r.to.to);
  const chart = storedFare ? storedFare.fare : r.to.chart;
  const kind = est ? 'estimated' : 'reported';
  return wa.buttons(to,
    `*${fareLabel(kind)}*\n\n*${r.from.name} → ${r.to.name}*\n\n${est ? 'Estimated fare' : 'Approved fare'}: *${money(chart)}*\n${r.to.bay}${q}${g}${est || prov(r)}`,
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

function asFuelAreaFollowUp(hash, text, c) {
  if (!text || !c || c.intent === 'fuel') return c;
  const lastOut = [...memory.recent(hash)].reverse().find(m => m.direction === 'out');
  const body = (lastOut && lastOut.body) || '';
  if (!/Fuel watch/.test(body) && !/\*Fuel —/.test(body)) return c;
  const t = String(text).trim().toLowerCase();
  if (t !== 'accra' && t !== 'tema') return c;
  return { ...c, intent: 'fuel', places: [t] };
}

/* A short tip at the end of a fuel card, until they have the add-on. */
function fuelWatchIntro(hash) {
  if (caps.has(hash, 'fuel')) return '';
  return '\n\n_Tip: *Fuel watch* tells you when prices near you move — send *ADD FUEL*._';
}

function rememberFuel(hash, st) {
  const s = caps.subscriber(hash);
  s.context = { ...(s.context || {}), subject: { kind: 'fuel', id: st.id, name: st.name } };
}

function fuelLinkFromSubscriber(s) {
  if (!s) return null;
  if (s.station) {
    const routeKey = s.route && s.route.from && s.route.to ? s.route.from + ':' + s.route.to : null;
    return { stationId: s.station, routeKey, stopId: null, label: placeName(s.station) };
  }
  if (s.route && s.route.from && s.route.to) {
    return {
      stationId: s.route.from,
      routeKey: s.route.from + ':' + s.route.to,
      stopId: null,
      label: placeName(s.route.from) + ' → ' + placeName(s.route.to)
    };
  }
  return null;
}

function fuelLinkFromText(text) {
  const raw = String(text || '').trim().toLowerCase();
  if (raw === 'accra' || raw === 'tema') return null;
  const mentioned = routeMention(text);
  if (mentioned && mentioned.fromId && mentioned.toId) {
    return {
      stationId: mentioned.fromId,
      routeKey: mentioned.fromId + ':' + mentioned.toId,
      stopId: null,
      label: placeName(mentioned.fromId) + ' → ' + placeName(mentioned.toId)
    };
  }
  if (mentioned && mentioned.fromId) {
    return { stationId: mentioned.fromId, routeKey: null, stopId: null, label: placeName(mentioned.fromId) };
  }
  const choices = api.placeChoices(text);
  const station = choices.find(c => c.kind === 'station' && (c.name.toLowerCase() === raw || c.id === raw));
  if (station) return { stationId: station.id, routeKey: null, stopId: null, label: station.name };
  const stop = choices.find(c => c.kind === 'stop' && c.name.toLowerCase() === raw);
  if (stop) return { stationId: null, routeKey: null, stopId: stop.id, label: stop.name };
  return null;
}

function fuelConfirmLine(st, link, opened) {
  const agreed = fuelChecks.agreed(st.id);
  if (agreed) return `Confirmed by *${agreed.agrees.length}* other riders. The index price is unchanged.`;
  if (!link) {
    return 'Unverified. No rider has confirmed this price.\n\nName the station, the route, or the stop. I will ask the other riders there and save that request. I will not show a count until two of them agree.';
  }
  const where = `*${link.label}*`;
  if (!opened) return `Unverified. No rider has confirmed this price at ${where}.`;
  if (!opened.fresh) return `Unverified. Still waiting for two other riders at ${where} to agree.`;
  if (!opened.peers.length) {
    return `Unverified. You are the only rider at ${where} right now. I saved the request. I will not show a count until two others there agree.`;
  }
  const n = opened.peers.length;
  return `Unverified. I asked *${n}* rider${n === 1 ? '' : 's'} at ${where}. Two others have to agree before I show a count.`;
}

async function fuelPriceReplies(to, hash, st, link) {
  const storedPump = dataTable.pump(st.id);
  if (storedPump) {
    st = { ...st, petrol: storedPump.petrol, diesel: storedPump.diesel };
  }
  rememberFuel(hash, st);
  const s = caps.subscriber(hash);
  const useLink = link || fuelLinkFromSubscriber(s);
  let opened = null;
  if (useLink) {
    opened = await fuelChecks.open(st, useLink, hash);
    s.context = { ...(s.context || {}), awaitingFuelPlace: null };
  } else {
    s.context = { ...(s.context || {}), awaitingFuelPlace: st.id, subject: { kind: 'fuel', id: st.id, name: st.name } };
  }
  const card = wa.buttons(to,
    `*${st.name}*\n\n\`\`\`Petrol   ₵${st.petrol.toFixed(2)}/L\nDiesel   ₵${st.diesel.toFixed(2)}/L\nArea     ${st.area}\`\`\`\n\n${fuelConfirmLine(st, useLink, opened)}${fuelWatchIntro(hash)}`,
    [{ id: 'addon:add:FUEL', title: 'Add fuel watch' }, { id: 'menu', title: 'Main menu' }]);
  if (!opened || !opened.fresh || !opened.peers.length) return [card];
  const asks = opened.peers.map(p => wa.buttons(p.reach,
    `Does this pump price match?\n\n*${st.name}*\nPetrol ₵${st.petrol.toFixed(2)}/L\nDiesel ₵${st.diesel.toFixed(2)}/L\n\nLinked to *${useLink.label}*. Your answer does not change the index price.`,
    [{ id: `fuelcheck:yes:${opened.row.id}`, title: 'Yes, it matches' }, { id: `fuelcheck:no:${opened.row.id}`, title: 'No' }]));
  return [card, ...asks];
}

function prefixFuelWatch(hash, payload) {
  const line = fuelWatchIntro(hash);
  if (!line || !payload) return payload;
  const fits = body => body.length + line.length <= 1024;
  if (payload.interactive && payload.interactive.body && payload.interactive.body.text) {
    if (fits(payload.interactive.body.text)) payload.interactive.body.text += line;
    return payload;
  }
  if (payload.text && payload.text.body && fits(payload.text.body)) payload.text.body += line;
  return payload;
}

async function answerFuel(to, hash, c) {
  const named = c && c.fuelId && (api.core.fuel.stations || []).find(x => x.id === c.fuelId);
  if (named) return fuelPriceReplies(to, hash, named);
  const saidAreas = ['accra', 'tema'].filter(a => new RegExp(`\\b${a}\\b`).test(String((c && c.raw) || '').toLowerCase()));
  if (c.compare && (saidAreas.length === 2 || c.places.length >= 2)) {
    const [a, b] = saidAreas.length === 2 ? saidAreas : c.places;
    const r = api.fuelCompare(a, b);
    if (!r) return [wa.text(to, 'I only have Accra and Tema loaded so far.')];
    const tank = (r.gap * 45).toFixed(0);
    return [prefixFuelWatch(hash, wa.buttons(to,
      `*Petrol — ${cap1(a)} vs ${cap1(b)}*\n\n\`\`\`${cap1(a).padEnd(9)}₵${r.a.petrol.toFixed(2)}   diesel ₵${r.a.diesel.toFixed(2)}\n${cap1(b).padEnd(9)}₵${r.b.petrol.toFixed(2)}   diesel ₵${r.b.diesel.toFixed(2)}\n${'gap'.padEnd(9)}₵${r.gap.toFixed(2)}/L\`\`\`\n\n*${cap1(r.cheaper)} is cheaper* — about ₵${tank} on a 45-litre fill.${prov(r)}`,
      [
        { id: `fuel:${a}`, title: `Stations in ${cap1(a)}` },
        { id: `fuel:${b}`, title: `Stations in ${cap1(b)}` },
        { id: 'addon:add:FUEL', title: 'Add fuel watch' }
      ]))];
  }

  const area = fuelArea(hash, c);
  const looked = tools.execute('fuel_prices', { text: (c && c.raw) || '', area: area || '' });
  if (!area) {
    if (!(c.places || []).length) {
      return [wa.buttons(to,
        `Sure — which area? I have pump prices for Accra and Tema. Or name the pump, like *GOIL Tema Community 1*.${fuelWatchIntro(hash)}`,
        [{ id: 'fuel:accra', title: 'Accra' }, { id: 'fuel:tema', title: 'Tema' }, { id: 'loc', title: 'Near me' }])];
    }
    if ((c.places || []).length) {
      const name = placeLabel(c.places[0]) || c.places[0];
      if (!api.station(c.places[0])) return [askWhereNow(to, caps.subscriber(hash), 'fuel', name)];
      setAwaitingPlace(caps.subscriber(hash), 'fuel', false);
      return [whereCard(to, `I only have Accra and Tema fuel prices, not *${name}*. Pick one, or share where you are.`,
        [{ id: 'fuel:accra', title: 'Accra' }, { id: 'fuel:tema', title: 'Tema' }, { id: 'pin', title: '📍 Share location' }])];
    }
    return [askPlace(to, caps.subscriber(hash), 'fuel')];
  }
  caps.subscriber(hash).context = { ...(caps.subscriber(hash).context || {}), subject: { kind: 'fuel-area', area } };
  const priced = looked.rows || [];
  const windowLine = looked.window || {};
  const rows = priced.map((s, i) => {
    const agreed = fuelChecks.agreed(s.id);
    const riders = agreed ? ` · ${agreed.agrees.length} riders` : '';
    return {
      id: `fuelstation:${s.id}`,
      title: `${i === 0 ? '★ ' : ''}${s.name}`,
      description: `Petrol ₵${s.petrol.toFixed(2)} · diesel ₵${s.diesel.toFixed(2)}${riders}`
    };
  });
  return [prefixFuelWatch(hash, wa.list(to,
    `*Fuel — ${cap1(area)}*\nCheapest first, petrol per litre.${prov({ source: 'both', authority: 'NPA window + rider confirmations' })}`,
    'See stations',
    [{ title: 'Petrol · per litre', rows }],
    null,
    `${windowLine.window || ''} · floor ₵${Number(windowLine.petrol_floor || 0).toFixed(2)}`
  ))];
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
  if (!(c.places || []).length) {
    tools.execute('needs', { subject: 'road', missing: 'road' });
    return wa.text(to, 'Which road?\n\nName it, for example *Tema Motorway*, or share where you are.');
  }
  const road = c.places.find(p => String(p).includes('motorway')) || c.places[0];
  const pack = tools.execute('road_status', { road: placeLabel(road) || road });
  const list = pack.incidents || [];
  if (!list.length) {
    return wa.buttons(to, 'Nothing reported on that road in the last hour. Send a photo from WhatsApp if you can see the blockage — that picture is the report.',
      [{ id: 'addon:add:ROADS', title: 'Add road alerts' }, { id: 'menu', title: 'Main menu' }]);
  }
  const i = list[0];
  caps.subscriber(hash).context = { ...(caps.subscriber(hash).context || {}), road: i.road };
  const mins = Math.round((Date.now() - Date.parse(i.reported_at)) / 60000);
  const delayLine = i.delay ? `\nDelay       ${i.delay}` : '';
  const whereLine = i.where ? `${i.where}\n\n` : '';
  return wa.buttons(to,
    `⚠ *${i.road}*\n\n*${i.kind}*\n${whereLine}\`\`\`Reported    ${mins} min ago${delayLine}\nConfirmed   ${i.confirmations} riders\nSource      ${i.source}\`\`\`${prov({ source: 'crowd', authority: pack.authority })}`,
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
  const bayPack = tools.execute('queue_status', { station: st.id });
  const rows = (bayPack.bays || []).map(f => {
    return {
      id: `queue:${st.id}:${f.dest}`,
      title: clip(f.name, 24),
      description: clip(f.state ? `${DOT[f.state]} ${f.state} · ${f.age_min}m ago · ${f.pings} pings` : 'No data yet', 72)
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
  const loaded = tools.execute('charts', {});
  const charts = loaded.charts || [];
  const survey = loaded.survey || {};
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

/**
 * Drop every question the bot is waiting on — the open fare question, "where
 * are you?", a road report's place, a pump link, a fare amount. Called when a
 * new conversation starts and when the rider asks for something new.
 */
function closeOpenQuestions(hash, s) {
  memory.setThread(hash, null);
  if (!s) return;
  clearAwaitingPlace(s);
  clearAwaitingRoadWhere(s);
  s.pending = null;
  if (s.context) {
    const context = { ...s.context };
    delete context.awaitingFuelPlace;
    delete context.atName;
    s.context = context;
  }
}

/** Is the bot waiting on an answer from this rider? */
function hasOpenQuestion(hash, s) {
  return !!(memory.thread(hash) || (s && (s.pending || awaitingPlace(s) || awaitingRoadWhere(s)
    || (s.context && (s.context.awaitingFuelPlace || s.context.atName)))));
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
  station: `*Where are you now?*\n\nType the station or area — like *Kaneshie* or *Circle*.\n\n${SHARE_LINE}`,
  fare: `*Where are you now?*\n\nType the station you are starting from — like *Kaneshie* — or the whole trip, like *Kaneshie to Circle*.\n\n${SHARE_LINE}`,
  fuel: `*Where are you now?*\n\nType the area — like *Tema* or *Accra* — or the pump name.\n\n${SHARE_LINE}`,
  queue: `*Where are you now?*\n\nType the station — like *Circle* or *Kaneshie*.\n\n${SHARE_LINE}`
};

function askWhereNow(to, s, reason, missing) {
  setAwaitingPlace(s, reason || 'station', false);
  const named = missing
    ? `I do not have *${String(missing).replace(/\*/g, '').trim()}* on the map yet.\n\n`
    : '';
  return whereCard(to, named + `*Where are you now?*\n\nType the station or area — like *Kaneshie*.\n\n${SHARE_LINE}`);
}

function askPlace(to, s, reason) {
  setAwaitingPlace(s, reason, false);
  return whereCard(to, PLACE_ASK[reason] || PLACE_ASK.station);
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

async function finishPlace(from, hash, s, c) {
  const reason = (awaitingPlace(s) && awaitingPlace(s).reason) || 'station';
  clearAwaitingPlace(s);
  const places = (c && c.places) || [];
  if (places[0]) caps.subscriber(hash).station = places[0];
  if (reason === 'fuel') {
    return answerFuel(from, hash, { ...(c || {}), places, compare: !!(c && c.compare) || places.length >= 2, scope: c && c.scope });
  }
  if (reason === 'queue') return answerQueue(from, hash, { places });
  if (places.length >= 2) return answerFare(from, hash, places[0], places[1]);
  if (places.length === 1) return answerStationBoard(from, hash, places[0], c && c.metres, { here: true });
  return askPlace(from, s, reason);
}

function noteRephrase(hash, s, text) {
  const now = Date.now();
  const prev = s.lastAsk;
  const t = String(text || '').trim();
  const question = q => !!(routeMention(q) || fareAsk(q) || isFuelTalk(q));
  if (prev && now - prev.at < 90000 && question(prev.text) && question(t)
      && prev.text.toLowerCase() !== t.toLowerCase()) {
    crowd.signal(hash, 'miss', prev.text);
  }
  s.lastAsk = { text: t, at: now };
}

function reactionId(emoji) {
  const e = String(emoji || '');
  if (/^👍/.test(e)) return 'sig:up';
  if (/^👎/.test(e)) return 'sig:down';
  return null;
}

function isNavCommand(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!?]+$/g, '');
  return /^(main menu|home|menu|hi|hello|hey|start|help)$/.test(t);
}

function isFuelTalk(text) {
  return /\b(fuel|petrol|diesel|pump|filling station|gas|goil|foil)\b/i.test(String(text || ''));
}

async function handleTypedPlace(from, hash, s, text) {
  const waiting = awaitingPlace(s);
  if (!waiting) return null;
  if (isPlaceDecline(text)) return [askPlaceTyped(from, s, waiting.reason)];
  if (isNavCommand(text) || isFuelTalk(text) || routeMention(text) || atStatement(text) || stopsQuery(text)) {
    clearAwaitingPlace(s);
    return null;
  }
  const c = await classify(text);
  if (c.places && c.places.length) {
    const done = await finishPlace(from, hash, s, c);
    return Array.isArray(done) ? done : [done];
  }
  if (c.intent && ['greet', 'chat', 'help', 'addon_add', 'addon_remove', 'addon_list', 'road'].includes(c.intent) && c.nlu !== 'heuristic') {
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
  return whereCard(to,
    '*Which country are you in?*\n\nTap *Ghana*, or type your country. I only use it to pick the right fares.',
    [{ id: 'country:gh', title: '🇬🇭 Ghana' }, { id: 'place', title: '⌨️ Type it' }, { id: 'pin', title: '📍 Share location' }]);
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
  return whereCard(to,
    `Photo saved${named} as ${seen}. WhatsApp photos carry no location, so I need you to say where.\n\n*Where is it?* Type the road or a landmark — like *Kaneshie overpass*.\n\nOr tap *Share location* if you are there now.`);
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
`${voice.line('help', {}, hash)} Just text me the way you would text a friend — short is fine.

*How to talk to me*

*Ask naturally*
\u2022 from → to, like *Kaneshie to Circle*
\u2022 *the stops* on a route
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
    lines.push(`Type the station name, or both ends — like *Kaneshie to Circle*. Or tap *Share location* and I will use the nearest *${mentioned.fromText}* to you.`);
    return whereCard(from, lines.join('\n\n'));
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
  setParse({ intent: 'fare', places: [next.fromId, next.toId].filter(Boolean), via: 'memory' });
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

function fuelAddressReply(from, st) {
  const q = encodeURIComponent(st.name + ', ' + st.area + ', Ghana');
  return wa.text(from,
    `*${st.name}*\n\nArea: *${st.area}*.\n\nThe fuel index does not have a street address for this pump. Open the map:\nhttps://www.google.com/maps/search/?api=1&query=${q}`);
}

function lastFuelStation(hash, s) {
  const subject = s.context && s.context.subject;
  if (subject && subject.kind === 'fuel') {
    const st = api.core.fuel.stations.find(x => x.id === subject.id);
    if (st) return st;
  }
  const outs = memory.recent(hash).filter(m => m.direction === 'out');
  for (let i = outs.length - 1; i >= 0 && i >= outs.length - 6; i--) {
    const body = outs[i].body || '';
    const st = api.core.fuel.stations.find(x => body.includes(x.name));
    if (st) return st;
  }
  return null;
}

function databaseFacts(hash, s) {
  const facts = [];
  const fuel = lastFuelStation(hash, s);
  if (fuel) {
    facts.push({
      kind: 'fuel', id: fuel.id, name: fuel.name, area: fuel.area,
      petrol: fuel.petrol, diesel: fuel.diesel
    });
  }
  if (s.station) {
    const st = api.station(s.station);
    if (st) facts.push({ kind: 'station', id: st.id, name: st.name });
  }
  return facts;
}

function fuelFromInquiry(c, hash, s, text) {
  for (const id of (c && c.places) || []) {
    const st = api.core.fuel.stations.find(x => x.id === id || String(x.name).toLowerCase() === String(id).toLowerCase());
    if (st) return st;
  }
  const named = api.core.fuel.stations.find(st => String(text || '').toLowerCase().includes(st.name.toLowerCase()));
  return named || lastFuelStation(hash, s);
}

async function answerFromAsk(from, hash, s, text, c) {
  const ask = c && c.ask;
  if (ask !== 'address' && ask !== 'price' && ask !== 'confirm') return null;
  const st = fuelFromInquiry(c, hash, s, text);
  if (!st) {
    if (ask === 'address') return [wa.text(from, 'Address of which place? Open a fuel station, or name it.')];
    return null;
  }
  if (ask === 'address') return [fuelAddressReply(from, st)];
  if (ask === 'price') {
    return [wa.text(from, `*${st.name}*\n\nPetrol *₵${st.petrol.toFixed(2)}*/L\nDiesel *₵${st.diesel.toFixed(2)}*/L\n\n_${st.area}. From the fuel index._`)];
  }
  return fuelPriceReplies(from, hash, st);
}

function answerAboutSubject(from, hash, s, text) {
  const t = String(text || '').toLowerCase().replace(/[?!.]/g, '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 80) return null;
  if (/^(where am i|where i am|find my station|locate me)$/.test(t)) return null;
  const named = api.core.fuel.stations.find(st => t.includes(st.name.toLowerCase()));
  const wantsAddress = /^(address|the address|its address|location|directions|map)$/.test(t)
    || /^(what is the address|whats the address)$/.test(t)
    || /^address of\b/.test(t);
  const wantsWhere = /^(where|where is it|where is this|where is that|how do i get there)$/.test(t);
  if (!wantsAddress && !wantsWhere) return null;
  const st = named || lastFuelStation(hash, s);
  if (st && (wantsAddress || wantsWhere)) return [fuelAddressReply(from, st)];
  if (wantsAddress) {
    const area = s.context && s.context.subject && s.context.subject.kind === 'fuel-area' ? s.context.subject.area : null;
    const which = area ? `Which pump in *${cap1(area)}*? Tap one, or name it.` : 'Address of which place? Open a fuel station, or name it.';
    return [wa.text(from, which)];
  }
  return null;
}

function finishOpenRoute(from, hash, next, note) {
  if (next.fromId) caps.subscriber(hash).station = next.fromId;
  if (next.fromId && next.toId) {
    memory.setThread(hash, null);
    setParse({ intent: 'fare', places: [next.fromId, next.toId], via: 'memory' });
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
  setParse({ intent: 'fare', places: [next.fromId, next.toId].filter(Boolean), via: 'memory' });
  return [askRouteRemaining(from, next, note)];
}

async function continueOpenRoute(from, hash, text) {
  const open = memory.thread(hash);
  if (!open || open.intent !== 'fare') return null;
  const low = String(text || '').trim().toLowerCase();
  if (/^(hi|hello|hey|menu|main menu|home|help|stop|cancel)$/.test(low) || /^(add|remove|my addons)\b/.test(low)) {
    memory.setThread(hash, null);
    return null;
  }
  if (/\b(road|fuel|petrol|diesel|gas|goil|foil|pump|queue)\b/.test(low) && !/\b(fare|fate|trotro)\b/.test(low)) {
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
      setParse({ intent: 'fare', places: [nextTown.toId].filter(Boolean), via: 'memory' });
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
    const unknownSide = !next.fromId ? next.fromText : (!next.toId ? next.toText : null);
    if (unknownSide && !isVaguePlace(unknownSide)) {
      next.naming = unknownSide;
      next.picking = next.fromId ? 'to' : 'from';
      crowd.signal(hash, 'unknown', unknownSide);
    }
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
    setParse({ intent: 'fare', places: [next.fromId, next.toId].filter(Boolean), via: 'memory' });
    return [offerPlaceChoices(from, next, slot, choices)];
  }
  const hint = api.suggestPlace(phrase);
  if (hint) {
    if (slot === 'to') next.toText = phrase;
    else next.fromText = phrase;
    next.picking = slot;
    memory.setThread(hash, next);
    setParse({ intent: 'fare', places: [next.fromId, next.toId].filter(Boolean), via: 'memory' });
    return [wa.buttons(from, `Did you mean *${hint.name}*?`, [
      { id: `did:${hint.id}`, title: clip(hint.name, 20) },
      { id: 'did:no', title: 'Not that' }
    ])];
  }
  if (slot === 'to') next.toText = phrase;
  else next.fromText = phrase;
  next.naming = phrase;
  next.picking = slot;
  memory.setThread(hash, next);
  setParse({ intent: 'fare', places: [next.fromId, next.toId].filter(Boolean), via: 'memory' });
  crowd.signal(hash, 'unknown', phrase);
  return [whereCard(from, `I do not have *${phrase.replace(/\*/g, '')}* on the map yet.\n\nType a station near it, or tap *Share location* if you are there — I will attach the name to the nearest station. It stays pending until another rider there agrees.`)];
}

async function withLocationChoices(from, hash, payloads, channel) {
  const list = Array.isArray(payloads) ? payloads : (payloads ? [payloads] : []);
  const asks = list.some(p => p && p.interactive && p.interactive.type === 'location_request_message');
  if (!asks || list.some(p => /\/loc\//.test(replyText(p)))) return list;
  const token = await locationLink.issue({ hash, from, channel: channel || 'whatsapp' });
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
  setParse({ ...c, intent: 'road' });
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

module.exports = {
  prov, clip, listSections, whereCard, asksWhere, WHERE_BUTTONS, addonMenu, addonAdd, addonRemove, addonList, answerStationBoard,
  fareLabel, answerComposed, answerEstimatedRange, withNote, answerStops, stopsPicker, answerStopsAsk, clarify,
  answerPass, answerServed, answerWhereIs,
  legNote, answerAt,
  answerFare, answerCheapest, asFuelAreaFollowUp, fuelWatchIntro, rememberFuel,
  fuelLinkFromSubscriber, fuelLinkFromText, fuelConfirmLine, fuelPriceReplies, prefixFuelWatch,
  answerFuel, placeLabel, conditionFromText, roadFromContext, answerRoad, answerQueue,
  answerCharts, cap1, isPlaceDecline, closeOpenQuestions, hasOpenQuestion, awaitingPlace, setAwaitingPlace, clearAwaitingPlace,
  askWhereNow, askPlace, askPlaceTyped, fuelArea, finishPlace, noteRephrase, reactionId,
  isNavCommand, isFuelTalk, handleTypedPlace, awaitingCountry, setAwaitingCountry,
  clearAwaitingCountry, setCountry, askCountry, askCountryTyped, noCountryData, afterCountry,
  applyCountryFromCoords, liveCountry, awaitingRoadWhere, setAwaitingRoadWhere,
  clearAwaitingRoadWhere, inferPhotoKind, askRoadWhere, askRoadWhereTyped, askRoadKind,
  askContractor, finishRoadWhere, finishContractor, pinWhereText, conversationalAutomationConfig,
  expandCommand, startMenu, welcome, keywordCard, mainMenu, replyText, placeName, askRouteFollowUp,
  fareReportReplies, continueOpenRouteFromPin, fareAsk, missingSlot, applyPlaceChoice,
  askRouteRemaining, offerPlaceChoices, fuelAddressReply, lastFuelStation, databaseFacts,
  fuelFromInquiry, answerFromAsk, answerAboutSubject, finishOpenRoute, continueOpenRoute,
  withLocationChoices, withSignals, handleRoadPhoto, answerRoadHistory, handleRoadTextReport,
  pushFuelAlert, pushRoadAlert, pushQueueAlert, pushChartRevision, money, DOT, PLACE_ASK, COMMANDS,
  ICE_BREAKERS, COMMAND_MAP, ICE_MAP
};
