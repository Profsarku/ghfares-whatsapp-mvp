/**
 * Tools the model calls. Fares, fuel, roads, queues, charts, add-ons,
 * and unfinished questions each have a tool. The tool reads the table.
 * A number in the model arguments is dropped.
 */
const { api, PLACES, routeMention, exactPlace, isVaguePlace, isAddonUtterance, atStatement, stopsQuery } = require('./api');
const fareGraph = require('./fare-graph');
const platform = require('./platform-graph');
const caps = require('./capabilities');

const SCHEMAS = [
  { type: 'function', function: { name: 'conversation', description: 'Menu, greeting, or help. Not a place lookup.', parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['menu', 'greet', 'help', 'where'] } }, required: ['kind'] } } },
  { type: 'function', function: { name: 'resolve_place', description: 'Map a nickname, typo, or local name to a station id. Does not invent a stop.', parameters: { type: 'object', properties: { phrase: { type: 'string' } }, required: ['phrase'] } } },
  { type: 'function', function: { name: 'plan_fare', description: 'Fare for two places. Direct table leg, cheapest sum of real legs, or a per-km range only when nothing connects them.', parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } } },
  { type: 'function', function: { name: 'fuel_prices', description: 'Pump prices from the NPA window table. Never invent a price.', parameters: { type: 'object', properties: { text: { type: 'string' }, area: { type: 'string' } } } } },
  { type: 'function', function: { name: 'road_status', description: 'Live road reports. Empty means nothing is logged, not that the road is clear.', parameters: { type: 'object', properties: { road: { type: 'string' } } } } },
  { type: 'function', function: { name: 'queue_status', description: 'Loading-bay state for a station and destination.', parameters: { type: 'object', properties: { station: { type: 'string' }, dest: { type: 'string' } } } } },
  { type: 'function', function: { name: 'charts', description: 'Which fare charts are loaded. Does not invent a revision.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'addons', description: 'Match or list add-ons: fuel, roads, route, queue, chart, report, location.', parameters: { type: 'object', properties: { text: { type: 'string' }, action: { type: 'string', enum: ['add', 'remove', 'list', 'match'] } }, required: ['text'] } } },
  { type: 'function', function: { name: 'needs', description: 'An informal or unfinished question. Say what is missing. Do not guess a place or a price.', parameters: { type: 'object', properties: { subject: { type: 'string' }, missing: { type: 'string' } }, required: ['subject', 'missing'] } } },
  { type: 'function', function: { name: 'route_stops', description: 'Stop names on one recorded leg, in stored order. No fare per stop.', parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } } },
  { type: 'function', function: { name: 'at_place', description: 'The rider said where they are. A park opens that station. A stop uses the legs that contain it.', parameters: { type: 'object', properties: { phrase: { type: 'string' } }, required: ['phrase'] } } }
];

const NAMES = new Set(SCHEMAS.map(s => s.function.name));

function fuelTalk(text) {
  return /\b(fuel|petrol|diesel|pump|filling station|gas|goil|foil)\b/i.test(String(text || ''));
}

function fareTalk(text) {
  const t = String(text || '');
  if (fuelTalk(t)) return false;
  return /\b(fare|fate|trotro|tro tro|how much|dropping|kalabule|wo bay jay sen|how much be|how e be)\b/i.test(t);
}

function roadTalk(text) {
  return /\b(wahala|road condition|traffic|highway|motorway|pothole|pot hole|blocked|blockage|accident|crash|flood|flooded)\b/i.test(String(text || ''));
}

function queueTalk(text) {
  return /\b(queue|cars dey|line dey|bay)\b/i.test(String(text || ''));
}

function chartTalk(text) {
  return /\b(fare chart|gprtu chart|what chart|chart revision)\b/i.test(String(text || ''));
}

function navKind(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!?]+$/g, '');
  if (/^(main menu|home|menu)$/.test(t)) return 'menu';
  if (/^(hi|hello|hey|start)$/.test(t)) return 'greet';
  if (/^help$/.test(t)) return 'help';
  if (/^(where|where am i)$/.test(t)) return 'where';
  return null;
}

function asLeg(edge, stopId, endpoint) {
  return {
    fromId: edge.from,
    fromName: edge.fromName,
    toId: edge.to,
    toName: edge.toName,
    chart: edge.fare,
    estimated: edge.estimated,
    stopId: stopId || edge.to,
    endpoint: !!endpoint
  };
}

function placeReply(node) {
  if (!node) return null;
  if (node.departures.length) return { graph: 'place', kind: 'station', id: node.id, name: node.name };
  if (node.arrivals.length) {
    return {
      graph: 'place',
      kind: 'stop',
      id: node.id,
      name: node.name,
      legs: node.arrivals.map(edge => asLeg(edge, node.id, true))
    };
  }
  return { graph: 'place', kind: 'map', id: node.id, name: node.name, region: node.region || null };
}

function execute(name, args) {
  const a = args || {};
  if (name === 'conversation') return { graph: 'conversation', kind: a.kind || 'menu' };
  if (name === 'resolve_place') {
    const phrase = String(a.phrase || '');
    const id = isVaguePlace(phrase) ? null : exactPlace(phrase);
    const st = id ? api.station(id) : null;
    return {
      graph: 'place',
      phrase,
      id: id || null,
      name: (st && st.name) || null,
      vague: isVaguePlace(phrase),
      suggestion: id ? null : (api.suggestPlace(phrase) || null)
    };
  }
  if (name === 'plan_fare') {
    const from = exactPlace(a.from) || a.from;
    const to = exactPlace(a.to) || a.to;
    const direct = api.fare(from, to);
    if (direct && direct.kind === 'leg') {
      const estimated = direct.to.chart_status === 'estimate_pending_chart';
      return {
        graph: 'fare',
        kind: estimated ? 'estimated' : 'reported',
        total: direct.to.chart,
        from: direct.from.name,
        to: direct.to.name,
        legs: [{ fromName: direct.from.name, toName: direct.to.name, fare: direct.to.chart, estimated }]
      };
    }
    if (direct && direct.kind === 'intercity') {
      const best = direct.route.options.reduce((x, y) => (x.amount <= y.amount ? x : y));
      return { graph: 'fare', kind: 'reported', total: best.amount, from: direct.route.from, to: direct.route.to, legs: [] };
    }
    const fromId = (api.station(from) && api.station(from).id) || from;
    const toId = (api.station(to) && api.station(to).id) || to;
    const plan = fareGraph.planRoute(fromId, toId);
    if (!plan) return { graph: 'fare', kind: null, total: null, from, to, legs: [] };
    return { graph: 'fare', ...plan };
  }
  if (name === 'fuel_prices') {
    const named = platform.pumpByText(a.text);
    const window = platform.fuelWindow();
    if (named) return { graph: 'fuel', pump: named, window, rows: [named] };
    const area = a.area || (/\btema\b/i.test(a.text || '') ? 'Tema' : (/\baccra\b/i.test(a.text || '') ? 'Accra' : null));
    return { graph: 'fuel', window, area, rows: platform.pumps(area).slice(0, 8) };
  }
  if (name === 'road_status') {
    return {
      graph: 'road',
      road: a.road || null,
      incidents: platform.incidents(a.road || null).map(i => ({
        id: i.incidentId,
        road: i.road,
        kind: i.name,
        where: i.where || '',
        delay: i.delay || '',
        confirmations: i.confirmations,
        source: i.source,
        reported_at: i.reported_at,
        status: i.status
      })),
      authority: 'rider reports + traffic probes'
    };
  }
  if (name === 'queue_status') {
    if (!a.station) return { graph: 'queue', missing: 'station', bays: [] };
    const st = api.station(a.station);
    const here = st && platform.around(st.id);
    if (!here) return { graph: 'queue', station: a.station, missing: 'station', bays: [] };
    const edges = a.dest ? here.departures.filter(e => e.to === a.dest) : here.departures;
    return {
      graph: 'queue',
      station: here.id,
      name: here.name,
      bays: edges.map(edge => {
        const row = api.queue(here.id, edge.to);
        return {
          dest: edge.to,
          name: edge.toName,
          state: row ? row.state : null,
          age_min: row ? row.age_min : null,
          pings: row ? row.pings : null
        };
      })
    };
  }
  if (name === 'charts') {
    return {
      graph: 'chart',
      charts: platform.charts().map(c => ({
        authority: c.authority,
        status: c.status,
        effective_from: c.effective_from || '',
        note: c.note || ''
      })),
      survey: api.survey()
    };
  }
  if (name === 'addons') {
    const action = a.action || 'match';
    if (action === 'list') return { graph: 'addon', action, addons: platform.addons() };
    const cap = caps.resolve(a.text);
    const node = cap && platform.addon(cap.id);
    return node
      ? { graph: 'addon', action, id: node.id, keyword: node.keyword, title: node.title, reads: node.reads }
      : { graph: 'addon', action, id: null };
  }
  if (name === 'needs') {
    return { graph: 'subject', subject: a.subject, missing: a.missing || 'place', node: platform.subject(a.subject) };
  }
  if (name === 'route_stops') {
    const from = exactPlace(a.from) || a.from;
    const to = exactPlace(a.to) || a.to;
    const fromId = (api.station(from) && api.station(from).id) || from;
    const toId = (api.station(to) && api.station(to).id) || to;
    const leg = platform.fareBetween(fromId, toId, a.toText || a.to);
    if (!leg) return { graph: 'fare', from: fromId, to: toId, names: [] };
    return { graph: 'fare', from: leg.fromId, to: leg.toId, fromName: leg.fromName, toName: leg.toName, names: leg.names };
  }
  if (name === 'at_place') {
    const phrase = String(a.phrase || '').trim();
    const key = phrase.toLowerCase().replace(/[?!.]/g, '').trim();
    const directId = key && !isVaguePlace(key) ? PLACES[key] : null;
    const direct = placeReply(directId && platform.around(directId));
    if (direct && direct.kind !== 'map') return direct;
    const stops = platform.stopsNamed(phrase);
    if (stops.length) {
      const legs = [];
      const seen = new Set();
      for (const stop of stops) {
        for (const edge of stop.legs) {
          const route = edge.from + '>' + edge.to;
          if (seen.has(route)) continue;
          seen.add(route);
          legs.push(asLeg(edge, stop.stopId, false));
        }
      }
      if (legs.length) return { graph: 'stop', kind: 'stop', id: stops[0].stopId, name: stops[0].name, legs };
    }
    if (direct) return direct;
    const stationId = exactPlace(phrase);
    const station = stationId && api.station(stationId);
    const resolved = placeReply(station && platform.around(station.id));
    if (resolved) return resolved;
    return { graph: 'place', kind: 'unknown', phrase };
  }
  return { error: 'unknown tool' };
}

function executeCall(call) {
  const name = call && (call.name || (call.function && call.function.name));
  if (!NAMES.has(name)) return { error: 'unknown tool' };
  let args = (call && (call.arguments || (call.function && call.function.arguments))) || {};
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = {}; }
  }
  delete args.total;
  delete args.fare;
  delete args.price;
  delete args.amount;
  delete args.petrol;
  delete args.diesel;
  return execute(name, args);
}

function plan(text, classified) {
  const c = classified || {};
  const raw = String(text || '').trim();
  const calls = [];
  const run = (name, args) => {
    const result = execute(name, args);
    calls.push({ name, arguments: args, result });
    return result;
  };
  const nav = navKind(raw);
  if (nav) {
    run('conversation', { kind: nav });
    return { intent: nav === 'where' ? 'where' : nav, calls };
  }
  if (isAddonUtterance(raw) || c.intent === 'addon_add' || c.intent === 'addon_remove' || c.intent === 'addon_list') {
    const action = /^(remove|stop|drop)\b|turn off|switch off/i.test(raw) ? 'remove'
      : /my addons|addons/i.test(raw) ? 'list' : 'add';
    run('addons', { text: raw, action });
    return { intent: action === 'list' ? 'addon_list' : action === 'remove' ? 'addon_remove' : 'addon_add', calls };
  }
  const here = atStatement(raw);
  if (here) {
    run('at_place', { phrase: here });
    return { intent: 'where', calls };
  }
  const stopAsk = stopsQuery(raw);
  if (stopAsk) {
    if (stopAsk.fromText && stopAsk.toText) {
      run('route_stops', { from: stopAsk.fromId || stopAsk.fromText, to: stopAsk.toId || stopAsk.toText, toText: stopAsk.toText });
    }
    else run('needs', { subject: 'stops', missing: !stopAsk.fromId ? stopAsk.fromText : stopAsk.toText });
    return { intent: 'stops', calls };
  }
  if (fuelTalk(raw) || c.intent === 'fuel') {
    run('fuel_prices', { text: raw });
    return { intent: 'fuel', calls };
  }
  if (c.intent === 'road' || c.intent === 'incident_history' || (roadTalk(raw) && !fareTalk(raw))) {
    const named = raw.match(/\b(?:on|at|along)\s+(?:the\s+)?([a-z0-9][^?]*)/i);
    const mentioned = routeMention(raw);
    const road = (c.places && c.places[0])
      || (mentioned && mentioned.fromText && mentioned.toText ? `${mentioned.fromText} to ${mentioned.toText}` : null)
      || (named && named[1].trim())
      || null;
    if (road) run('road_status', { road });
    else run('needs', { subject: 'road', missing: 'road' });
    return { intent: 'road', calls };
  }
  if (queueTalk(raw) || c.intent === 'queue') {
    const station = (c.places && c.places[0]) || null;
    if (station) run('queue_status', { station, dest: (c.places && c.places[1]) || null });
    else run('needs', { subject: 'queue', missing: 'station' });
    return { intent: 'queue', calls };
  }
  if (chartTalk(raw) || c.intent === 'chart') {
    run('charts', {});
    return { intent: 'chart', calls };
  }
  const mentioned = routeMention(raw);
  if (mentioned) {
    run('resolve_place', { phrase: mentioned.fromText });
    run('resolve_place', { phrase: mentioned.toText });
    if (mentioned.fromId && mentioned.toId) run('plan_fare', { from: mentioned.fromId, to: mentioned.toId });
    else run('needs', { subject: 'fare', missing: !mentioned.fromId ? mentioned.fromText : mentioned.toText });
    return { intent: 'fare', calls };
  }
  if (fareTalk(raw) || c.intent === 'fare') {
    if (c.places && c.places.length >= 2) run('plan_fare', { from: c.places[0], to: c.places[1] });
    else run('needs', { subject: 'fare', missing: 'place' });
    return { intent: 'fare', calls };
  }
  if (c.intent === 'where') {
    run('conversation', { kind: 'where' });
    return { intent: 'where', calls };
  }
  if (c.places && c.places.length === 1) {
    run('resolve_place', { phrase: c.places[0] });
    return { intent: c.intent || 'station', calls };
  }
  return { intent: c.intent || null, calls };
}

module.exports = { schemas: SCHEMAS, execute, executeCall, plan };
