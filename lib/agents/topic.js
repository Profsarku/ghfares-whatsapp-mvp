/**
 * What the rider and the bot were last looking at — a station board, a
 * route, the stops on a leg. The data agent writes it when it shows one;
 * "that route", "there", and "the stops" are read against it, and the chat
 * agent is told about it in words (never with a figure).
 *
 * Kept on the subscriber's context so it survives across server instances.
 */
const FRESH_MS = 30 * 60 * 1000;

function get(s) {
  const t = s && s.context && s.context.topic;
  if (!t) return null;
  if (t.at && Date.now() - t.at > FRESH_MS) return null;
  return t;
}

function set(s, topic) {
  if (!s || !topic) return;
  s.context = { ...(s.context || {}), topic: { ...topic, at: Date.now() } };
}

function station(s, id, name) {
  set(s, { kind: 'station', stationId: id, name });
}

function route(s, leg) {
  set(s, { kind: 'route', fromId: leg.fromId, toId: leg.toId, fromName: leg.fromName, toName: leg.toName });
}

/* "that route", "this station", "same one", "there", "it" — the line leans on
   what was just shown instead of naming it again. */
const BACK = /\b(that|this|the same|same|those|these)\s+(route|road|station|park|place|one|trip|leg|line|car|trotro|stops?)\b|\b(there|it|them)\b|^(the )?stops\b/;

function refersBack(text) {
  return BACK.test(String(text || '').toLowerCase());
}

/* "last time", "yesterday", "like before" — the rider means an earlier conversation. */
const RECALL = /\b(last time|yesterday|the other day|before|previous(ly)?|earlier|again|same (route|one|place|station) as)\b/;

function recalls(text) {
  return RECALL.test(String(text || '').toLowerCase());
}

/** A plain description for the chat agent — names only, no figures. */
function describe(topic) {
  if (!topic) return '';
  if (topic.kind === 'station') return `the trotro routes from ${topic.name}`;
  if (topic.kind === 'route') return `the ${topic.fromName} to ${topic.toName} route`;
  return '';
}

module.exports = { get, set, station, route, refersBack, recalls, describe };
