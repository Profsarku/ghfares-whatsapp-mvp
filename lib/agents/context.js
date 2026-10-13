/**
 * Ghanaians text in fragments — "circle?", "e be how much", "the stops",
 * "and madina", "line dey?" — and expect the other side to remember what
 * was just on the screen. This reads a fragment against the topic (the
 * station board or route the data agent last showed) and says which lookup
 * it means. It never invents a place: a fragment that does not fit the
 * topic is left for the clarify step.
 */
const { api, routeMention } = require('../api');

const FARE = /\b(how much|hw much|hw mch|how mch|e be how much|ebe how much|fare|price|cost|charge|sen|kalabule|dropping)\b/;
const QUEUE = /\b(queue|line|cars? dey|bay|loading|dey move|full)\b/;
const MORE = /^(and|what about|how about|then|or|na|plus)\b/;

function norm(text) {
  return String(text || '').toLowerCase().replace(/[^\w\s']/g, ' ').replace(/\s+/g, ' ').trim();
}

function words(t) {
  return t ? t.split(' ').length : 0;
}

function hasLeg(fromId, toId) {
  const st = api.station(fromId);
  return !!(st && (st.fares || []).some(f => f.to === toId));
}

/** A fragment — short, or leaning on what came before. */
function isFragment(text) {
  const t = norm(text);
  return !!t && (words(t) <= 5 || MORE.test(t));
}

/**
 * @param {string} text
 * @param {object|null} topic from lib/agents/topic.js
 * @param {{ places?: string[] }} classified
 * @returns {{ action: 'fare'|'board'|'queue', from?: string, to?: string, station?: string } | null}
 */
function read(text, topic, classified) {
  if (!topic) return null;
  const t = norm(text);
  if (!isFragment(t)) return null;
  /* "fare from Barrier to town" names its own route — not a fragment. */
  if (routeMention(text)) return null;
  const places = ((classified && classified.places) || []).filter(Boolean);

  if (topic.kind === 'station') {
    const at = topic.stationId;
    const other = places.filter(p => p !== at);
    if (other.length === 1 && places.length <= 2 && (hasLeg(at, other[0]) || MORE.test(t))) return { action: 'fare', from: at, to: other[0] };
    if (!places.length && FARE.test(t)) return { action: 'board', station: at };
    if (!places.length && QUEUE.test(t)) return { action: 'queue', from: at };
    return null;
  }

  if (topic.kind === 'route') {
    const { fromId, toId } = topic;
    /* "and circle" is plainly the same origin; a bare "circle?" only when a car goes there. */
    if (places.length === 1 && places[0] !== fromId && places[0] !== toId
      && (MORE.test(t) || (words(t) <= 2 && hasLeg(fromId, places[0])))) {
      return { action: 'fare', from: fromId, to: places[0] };
    }
    if (!places.length && FARE.test(t)) return { action: 'fare', from: fromId, to: toId };
    if (!places.length && QUEUE.test(t)) return { action: 'queue', from: fromId, to: toId };
  }
  return null;
}

/* A question the bot did not understand, as opposed to a feeling or a story:
   it gets a clarifying question back, not small talk. */
const QUESTION = /\?|^(what|wetin|which|where|wey|how|hw|when|who|is|are|can|do|does|any|e dey|e get|you get|sey|abeg|pls|please)\b/;

function looksLikeQuestion(text) {
  const t = String(text || '').trim().toLowerCase();
  return QUESTION.test(t) || (words(norm(t)) <= 3 && !/^(no|nope|yes|yeah|ok|okay|fine)$/.test(norm(t)));
}

module.exports = { read, isFragment, looksLikeQuestion };
