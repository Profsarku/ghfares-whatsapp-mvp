/**
 * Chat that is not a lookup.
 * A fare, a pump price, or a road report never comes from here.
 * The model writes the reply when one is reachable; it may not state a
 * figure (nlu.chatReply drops any reply that does). Canned lines are the
 * fallback when no model is up.
 */
const wa = require('./wa');
const nlu = require('./nlu');

const DATA_TOOLS = new Set([
  'opensearch', 'plan_fare', 'fuel_prices', 'road_status', 'queue_status',
  'charts', 'needs', 'route_stops', 'at_place', 'resolve_place', 'addons'
]);

const DATA_INTENTS = new Set([
  'fare', 'fuel', 'road', 'road_history', 'queue', 'chart', 'cheapest',
  'station', 'incident_history', 'where', 'addon_add', 'addon_remove',
  'addon_list', 'help', 'stops'
]);

/* One lookup the chat reply may offer as a button. Ids are existing taps. */
const OFFERS = {
  fare: { id: 'ask:fare', title: 'Check a fare' },
  fuel: { id: 'ask:fuel', title: 'Fuel prices' },
  road: { id: 'ask:road', title: 'Road status' },
  queue: { id: 'loc', title: 'Find my station' },
  station: { id: 'loc', title: 'Find my station' }
};

function shouldChat(text, classified, planned) {
  const intent = classified && classified.intent;
  if (intent === 'chat') return true;
  const calls = (planned && planned.calls) || [];
  if (calls.some(call => DATA_TOOLS.has(call.name))) return false;
  /* A greeting opens a conversation. START and MENU still open the menu. */
  if (intent === 'greet') return !/^start$/i.test(String(text || '').trim());
  const conv = calls.find(call => call.name === 'conversation');
  if (conv) {
    const kind = (conv.arguments && conv.arguments.kind) || '';
    if (kind === 'menu' || kind === 'help' || kind === 'where') return false;
  }
  if (intent === 'menu' || intent === 'help') return false;
  if (!intent) return true;
  if (DATA_INTENTS.has(intent)) return false;
  return true;
}

/* Chat may answer in the middle of an open fare question or a pending
   report only when it is sure — a model said chat, or the line is plainly
   small talk. A guess must not swallow the answer the thread is waiting for.
   The thread stays open either way. */
function breaksThread(classified) {
  const c = classified || {};
  return c.intent === 'chat' && c.nlu !== 'heuristic' && c.nlu !== 'lexical';
}

function withOffer(to, body, offer) {
  const button = OFFERS[offer];
  return button ? wa.buttons(to, body, [button]) : wa.text(to, body);
}

function canned(text, recent) {
  const low = String(text || '').trim().toLowerCase().replace(/[.!?]+$/g, '');
  const last = [...(recent || [])].reverse().find(m => m.direction === 'out');
  const heard = !!(last && last.body);

  if (/^(hi|hello|hey|yo|ei|chale|charlie|good morning|good afternoon|good evening|how far|how you dey|how are you|how are you doing|wassup|what's up|whats up)\b/.test(low)) {
    return "Ei, I'm good, thanks for asking. How is your day going?";
  }
  if (/^(thanks|thank you|thx|medaase|akpe|nice one|cool|alright|ok|okay)\b/.test(low)) {
    return heard ? "Anytime. I'm here if you need anything else." : "You're welcome. How is your day going?";
  }
  if (/\b(who are you|what are you|who made you|what can you do|what's your name|where are you from|are you (a )?(bot|human|real))\b/.test(low)) {
    return "I'm GH Fares. I know trotro fares, fuel prices, roads, and station queues around Ghana — and I'm happy to just chat too.";
  }
  if (/\b(tired|exhausted|stress\w*|killing me|fed up|sick of|suffer\w*)\b/.test(low)) {
    return 'Ah, sorry. That sounds like a long day. Take it easy — what happened?';
  }
  if (/\b(rude|annoy\w*|vex\w*|angry|frustrat\w*|nonsense)\b/.test(low)) {
    return 'Eish, sorry about that. Nobody likes being treated like that. Do you want to tell me what happened?';
  }
  if (/\b(lol|haha|funny)\b/.test(low)) return 'Haha 😄';
  if (/\b(can we (just )?talk|let'?s (just )?talk|talk to me)\b/.test(low)) return "Sure, I'm here. What's on your mind?";
  if (heard && /^(yes|yeah|yep|no|nope|really|go on|and then|what about it|explain)$/.test(low)) {
    return 'Okay, go on. I am listening.';
  }
  return 'I hear you. Tell me more.';
}

async function reply(to, text, recent, offer) {
  const said = await nlu.chatReply(text, recent);
  return withOffer(to, said || canned(text, recent), offer);
}

module.exports = { shouldChat, breaksThread, reply, canned };
