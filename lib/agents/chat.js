/**
 * The chat agent — conversation, not lookups.
 *
 * It has no access to the fare, fuel, road, or queue tables, and it never
 * sees a figure: data replies reach its history as a one-line note of what
 * was shown, with every amount removed. When a rider asks for something the
 * data agent answers, the router sends that line there instead; this agent
 * only has to be good company and point the way.
 *
 * The model writes the reply when one is reachable. A reply that still
 * carries a figure is dropped for a canned line, and the graph's guard node
 * checks again on the way out.
 */
const wa = require('../wa');
const nlu = require('../nlu');
const topics = require('./topic');

const FIGURE = /[₵¢]|\bGH[S¢₵]?\s*\d|\d+(\.\d+)?\s*(cedis?|pesewas?|ghs)\b/i;

const SYSTEM = `You are GH Fares on WhatsApp — a warm, plain-spoken Ghanaian friend for people who ride trotros and drive in Ghana.
People text you the way they text a friend: short, informal, Pidgin or Twi mixed with English, often with no context. Read them generously and reply the same way — one to three short sentences, light Pidgin or Twi when they use it.
You are the conversation side of GH Fares. A lookup side answers fares, the stops on a route, fuel prices, road reports, and station queues from recorded data, and it takes over by itself when they ask for one of those. So never say you cannot help, and never say something "is not something you look up". If they seem to want transport information, say you can check it and ask for the one detail you still need, like which route or which station.
Answer what they actually said. Be kind when they are stressed or venting. Do not push a lookup on someone who is just talking.
NEVER state a fare, pump price, amount, cedi figure, time estimate, or road condition — the lookup side gives those.
No markdown headings, no lists, no links.`;

/* One lookup a chat reply may offer as a button. Ids are existing taps. */
const OFFERS = {
  fare: { id: 'ask:fare', title: 'Check a fare' },
  fuel: { id: 'ask:fuel', title: 'Fuel prices' },
  road: { id: 'ask:road', title: 'Road status' },
  queue: { id: 'loc', title: 'Find my station' },
  station: { id: 'loc', title: 'Find my station' }
};

const CHAT_INTENTS = new Set(['chat', 'greet', null, undefined]);

function scrub(body) {
  return String(body || '')
    .replace(/[₵¢]\s*\d[\d.,]*/g, '[amount]')
    .replace(/\bGH[S¢₵]?\s*\d[\d.,]*/gi, '[amount]')
    .replace(/\d+(\.\d+)?\s*(cedis?|pesewas?|ghs)\b/gi, '[amount]')
    .replace(/[*_`]/g, '')
    .trim();
}

/** The chat agent's view of the history: its own turns in full, data cards as a note. */
function view(rows) {
  return (rows || []).slice(-8).map(m => {
    if (m.direction !== 'out') return { role: 'user', content: String(m.body || '').slice(0, 600) };
    if (CHAT_INTENTS.has(m.intent)) return { role: 'assistant', content: scrub(m.body).slice(0, 600) };
    const head = scrub(String(m.body || '').split('\n').find(line => line.trim()) || '');
    return { role: 'assistant', content: `(showed them a ${m.intent || 'lookup'} card: ${head.slice(0, 120)})` };
  }).filter(m => m.content);
}

function ago(ms) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 60) return `${Math.max(min, 1)} minutes ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/** Earlier conversations as lines for the prompt — when, and what it covered. */
function pastLines(past) {
  return (past || []).filter(c => c && c.summary).map(c => `- ${ago(c.lastAt)}: ${c.summary}`).join('\n');
}

function prompt(topic, past) {
  let out = SYSTEM;
  const about = topics.describe(topic);
  if (about) out += `\nJust before this you showed them ${about}. If their message is about that, say what you can check for it.`;
  const lines = pastLines(past);
  if (lines) out += `\nYour earlier conversations with this person, newest first. Refer to them naturally when it helps, and do not invent anything that is not here:\n${lines}`;
  return out;
}

function withOffer(to, body, offer) {
  const button = OFFERS[offer];
  return button ? wa.buttons(to, body, [button]) : wa.text(to, body);
}

function canned(text, recent, topic, past) {
  const low = String(text || '').trim().toLowerCase().replace(/[.!?]+$/g, '');
  const last = [...(recent || [])].reverse().find(m => m.direction === 'out');
  const heard = !!(last && last.body);

  if (/^(hi|hello|hey|yo|ei|chale|chaley|charlie|good morning|good afternoon|good evening|morning|maakye|maaha|maadwo|ete sen|ɛte sɛn|wo ho te|how far|hw far|how you dey|how be|how are you|how are you doing|wassup|wasup|sup|what's up|whats up)\b/.test(low)) {
    return "Ei, I'm good, thanks for asking. How is your day going?";
  }
  if (/^(thanks|thank you|thx|medaase|akpe|nice one|cool|alright|ok|okay)\b/.test(low)) {
    return heard ? "Anytime. I'm here if you need anything else." : "You're welcome. How is your day going?";
  }
  if (/\b(who are you|what are you|who made you|what can you do|what's your name|where are you from|are you (a )?(bot|human|real))\b/.test(low)) {
    return "I'm GH Fares. I know trotro fares, the stops on a route, fuel prices, roads, and station queues around Ghana — and I'm happy to just chat too.";
  }
  if (/\b(tired|exhausted|stress\w*|killing me|fed up|sick of|suffer\w*)\b/.test(low)) {
    return 'Ah, sorry. That sounds like a long day. Take it easy — what happened?';
  }
  if (/\b(rude|annoy\w*|vex\w*|angry|frustrat\w*|nonsense)\b/.test(low)) {
    return 'Eish, sorry about that. Nobody likes being treated like that. Do you want to tell me what happened?';
  }
  if (/\b(lol|haha|funny)\b/.test(low)) return 'Haha 😄';
  if (/^(hmm+|ehh?|ah+|okay then|alright then)$/.test(low)) return 'Take your time 🙂 I am here.';
  if (/\b(can we (just )?talk|let'?s (just )?talk|talk to me)\b/.test(low)) return "Sure, I'm here. What's on your mind?";
  if (heard && /^(yes|yeah|yep|no|nope|really|go on|and then|what about it|explain)$/.test(low)) {
    return 'Okay, go on. I am listening.';
  }
  if (/\b(what did (we|i) (talk|chat|ask|say|check)|remember|last time|our (last|previous))\b/.test(low)) {
    const last = (past || [])[0];
    return last && last.summary
      ? `Yes, ${ago(last.lastAt)} we talked about ${last.summary}. Want to pick that up again?`
      : 'This is our first proper chat, so nothing to look back on yet. What do you need?';
  }
  const about = topics.describe(topic);
  if (about) return `I hear you. We were on ${about} — I can check a fare or list the stops for you, or we can just talk.`;
  return 'I hear you. Tell me more.';
}

/**
 * @param {{ to: string, text: string, prior?: object[], offer?: string, topic?: object|null }} msg
 */
async function reply({ to, text, prior, offer, topic, past }) {
  const messages = [{ role: 'system', content: prompt(topic, past) }, ...view(prior), { role: 'user', content: String(text || '') }];
  let said = await nlu.complete(messages, { temperature: 0.6 });
  if (said && FIGURE.test(said)) said = null;
  return withOffer(to, (said && said.slice(0, 900)) || canned(text, prior, topic, past), offer);
}

module.exports = { reply, canned, view, prompt, pastLines, SYSTEM };
