/**
 * The conversation agent — the model holds the conversation and calls tools,
 * the way a chat assistant does.
 *
 * Every typed message that is not the answer to an open question comes here
 * first. The model reads the conversation so far (data cards appear as notes
 * with the amounts removed), the topic on screen, and summaries of earlier
 * conversations. It either just talks, or calls one of the GH Fares tools
 * (fares, stops, fuel, roads, queues, charts, add-ons, where the rider is).
 *
 * The tool's answer reaches the rider as the usual card, built from the
 * recorded table — so every fare and price comes from the data, never from
 * the model. The model writes the human sentence on top and may not write a
 * figure itself; a reply that does is dropped for the card alone.
 *
 * Returns null when no model is reachable or it gives nothing usable, and
 * the graph falls back to the rule-based path (router, data agent, chat agent).
 * ASSISTANT=off turns it off without a deploy of code.
 */
const wa = require('../wa');
const nlu = require('../nlu');
const tools = require('../tools');
const { exactPlace } = require('../api');
const chat = require('./chat');
const topics = require('./topic');

const FIGURE = /[₵¢]|\bGH[S¢₵]?\s*\d|\d+(\.\d+)?\s*(cedis?|pesewas?|ghs)\b/i;

/* The tools the model may call. Each display tool becomes a card. */
const OFFERED = ['resolve_place', 'plan_fare', 'route_stops', 'fuel_prices', 'road_status', 'queue_status', 'charts', 'at_place', 'addons', 'conversation'];
const TOOLS = tools.schemas.filter(s => OFFERED.includes(s.function.name));
const DISPLAY = new Set(OFFERED.filter(n => n !== 'resolve_place'));

const INTENT_OF = {
  plan_fare: 'fare', route_stops: 'stops', fuel_prices: 'fuel', road_status: 'road', queue_status: 'queue',
  charts: 'chart', at_place: 'station', addons: 'addon_list', conversation: 'menu'
};

const SYSTEM = `You are GH Fares on WhatsApp — a warm, plain-spoken Ghanaian friend for people who ride trotros and drive in Ghana.
People text you like a friend: short, informal, Pidgin or Twi mixed with English, often with no context. Read them generously and use the conversation so far — "that route", "there", "how much" usually mean what you were just talking about.

You have tools that read GH Fares' recorded data: the fare between two places, the stops on a route, fuel prices, road reports, station queues, the fare charts, add-ons, and what is around a place the rider says they are at.
- When the rider wants something a tool has, call that tool. Use places the rider named, or ones from earlier in this conversation. Call one data tool per reply.
- If a place you need is missing, do not guess — ask for it in one short, friendly question.
- The tool's result is shown to the rider as a card right after your message, with the numbers. So NEVER write a fare, price, amount, time estimate, or road condition yourself. Write one or two warm sentences that introduce the card.
- For small talk, feelings, or questions about yourself, just talk. No tool.
- Keep it short: one to three sentences. Light Pidgin or Twi when they use it. No lists, no headings, no links.`;

function enabled() {
  return String(process.env.ASSISTANT || 'on').toLowerCase() !== 'off' && nlu.provider() !== 'off';
}

function systemPrompt({ topic, past }) {
  let out = SYSTEM;
  const about = topics.describe(topic);
  if (about) out += `\n\nOn the rider's screen right now: ${about}.`;
  const lines = chat.pastLines(past);
  if (lines) out += `\n\nEarlier conversations with this rider, newest first (refer to them when it helps; do not invent anything):\n${lines}`;
  return out;
}

const place = x => exactPlace(String(x || '')) || String(x || '').toLowerCase().trim();

/** The card for one display tool call, built by the same handlers the rule-based path uses. */
async function card(h, { from, hash, user }, call, result) {
  const a = call.arguments || {};
  switch (call.name) {
    case 'plan_fare':
      if (!a.from || !a.to) return null;
      return h.answerFare(from, hash, place(a.from), place(a.to));
    case 'route_stops':
      if (!a.from || !a.to) return null;
      return h.answerStops(from, { fromId: place(a.from), toId: place(a.to), fromText: a.from, toText: a.to }, hash);
    case 'fuel_prices':
      return h.answerFuel(from, hash, {
        places: a.area ? [String(a.area).toLowerCase()] : [], compare: false, scope: null, raw: a.text || '',
        fuelId: result && result.pump ? result.pump.id : undefined
      });
    case 'road_status':
      return h.answerRoad(from, hash, { places: a.road ? [place(a.road)] : [] });
    case 'queue_status':
      return h.answerQueue(from, hash, { places: a.station ? [place(a.station)] : [] });
    case 'charts':
      return h.answerCharts(from, hash);
    case 'at_place':
      return a.phrase ? h.answerAt(from, hash, user, a.phrase) : null;
    case 'addons': {
      const action = a.action || 'match';
      if (action === 'list') return h.addonList(from, hash);
      if (action === 'remove') return h.addonRemove(from, hash, a.text);
      if (action === 'add') return h.addonAdd(from, hash, a.text);
      return h.addonMenu(from, hash);
    }
    case 'conversation': {
      const kind = a.kind || 'menu';
      if (kind === 'help') return h.keywordCard(from, hash);
      if (kind === 'where') return h.askPlace(from, user, 'station');
      if (kind === 'menu') return h.startMenu(from, hash);
      return null;
    }
    default:
      return null;
  }
}

/**
 * @param {{ from: string, hash: string, user: object, text: string, prior?: object[], topic?: object|null, past?: object[] }} msg
 * @returns {Promise<{ replies: object[], intent: string, calls: string[] } | null>}
 */
async function respond(msg) {
  if (!enabled()) return null;
  const h = require('../conversation/handlers');
  const messages = [
    { role: 'system', content: systemPrompt(msg) },
    ...chat.view(msg.prior),
    { role: 'user', content: String(msg.text || '') }
  ];
  const called = [];
  let shown = null;
  let said = '';
  for (let step = 0; step < 3; step++) {
    const out = await nlu.completeWithTools(messages, TOOLS);
    if (!out) return null;
    const calls = (out.calls || []).filter(c => OFFERED.includes(c.name)).slice(0, 2);
    if (!calls.length || step === 2) {
      said = out.content || '';
      break;
    }
    messages.push({
      role: 'assistant',
      content: out.content || '',
      tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) } }))
    });
    for (const c of calls) {
      const result = tools.execute(c.name, c.arguments || {});
      called.push(c.name);
      if (DISPLAY.has(c.name)) shown = { call: c, result };
      messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result).slice(0, 4000) });
    }
    /* A card is ready: one more turn only to write the sentence on top of it. */
    if (shown) {
      const last = await nlu.completeWithTools(messages, TOOLS, { noCalls: true });
      said = (last && last.content) || '';
      break;
    }
  }

  said = String(said || '').trim().slice(0, 600);
  if (FIGURE.test(said)) said = '';

  let cards = shown ? await card(h, msg, shown.call, shown.result) : null;
  cards = (Array.isArray(cards) ? cards : [cards]).filter(Boolean);
  if (!cards.length && !said) return null;

  let replies;
  if (cards.length) {
    const fits = said && h.replyText(cards[0]).length + said.length + 2 <= 1024 && !cards[0].template;
    if (!said) replies = cards;
    else if (fits) replies = [h.withNote(cards[0], said), ...cards.slice(1)];
    else replies = [wa.text(msg.from, said), ...cards];
  } else {
    replies = [wa.text(msg.from, said)];
  }
  return {
    replies,
    intent: shown ? (INTENT_OF[shown.call.name] || 'chat') : 'chat',
    calls: called
  };
}

module.exports = { respond, enabled, systemPrompt, TOOLS, SYSTEM };
