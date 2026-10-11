/**
 * Chat that is not a lookup.
 * A fare, a pump price, or a road report never comes from here.
 */
const wa = require('./wa');

const DATA_TOOLS = new Set([
  'opensearch', 'plan_fare', 'fuel_prices', 'road_status', 'queue_status',
  'charts', 'needs', 'route_stops', 'at_place', 'resolve_place', 'addons'
]);

const DATA_INTENTS = new Set([
  'fare', 'fuel', 'road', 'road_history', 'queue', 'chart', 'cheapest',
  'station', 'incident_history', 'where', 'addon_add', 'addon_remove',
  'addon_list', 'help', 'stops'
]);

function shouldChat(text, classified, planned) {
  const calls = (planned && planned.calls) || [];
  if (calls.some(call => DATA_TOOLS.has(call.name))) return false;
  const conv = calls.find(call => call.name === 'conversation');
  if (conv) {
    const kind = (conv.arguments && conv.arguments.kind) || '';
    if (kind === 'menu' || kind === 'help' || kind === 'where' || kind === 'greet') return false;
  }
  const intent = classified && classified.intent;
  if (intent === 'menu' && classified && classified.nlu === 'heuristic') return true;
  if (intent === 'greet' || intent === 'menu' || intent === 'help') return false;
  if (!intent) return true;
  if (DATA_INTENTS.has(intent)) return false;
  return true;
}

function reply(to, text, recent) {
  const low = String(text || '').trim().toLowerCase().replace(/[.!?]+$/g, '');
  const last = [...(recent || [])].reverse().find(m => m.direction === 'out');
  const heard = !!(last && last.body);

  if (/^(hi|hello|hey|yo|ei|chale|charlie|good morning|good afternoon|good evening|how far|how you dey|how are you|how are you doing|wassup|what's up|whats up)$/.test(low)) {
    return wa.buttons(to,
      "Ei, I'm here.\n\nWe can just talk. If you want a fare, the fuel, the road, or a station, ask and I will look that up.",
      [{ id: 'menu', title: 'Main menu' }]);
  }
  if (/^(thanks|thank you|thx|medaase|akpe|nice one|cool|alright|ok|okay)$/.test(low)) {
    return wa.text(to, heard
      ? "You're welcome. If that was not what you meant, say it another way."
      : "You're welcome. Tell me what is going on.");
  }
  if (/\b(who are you|what are you|what can you do)\b/.test(low)) {
    return wa.text(to, "I'm GH Fares. Ask me about a fare, fuel, a road, or a station and I look it up. The rest of the time we can just talk.");
  }
  if (heard && /^(yes|yeah|yep|no|nope|really|go on|and then|what about it|explain)$/.test(low)) {
    return wa.text(to, "I hear you. Tell me the next bit in your own words — where you are, where you are going, or what is bothering you.");
  }
  return wa.buttons(to,
    "I'm with you. That is not something I look up, so tell me a bit more — where you are, where you are going, or what is happening.",
    [{ id: 'menu', title: 'Main menu' }]);
}

module.exports = { shouldChat, reply };
