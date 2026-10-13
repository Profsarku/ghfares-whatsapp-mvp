/**
 * A human first line for the data agent's cards, so a fare board reads like
 * a person answering and not a printout. Lines name places only — a figure
 * never comes from here, it comes from the table underneath.
 */
const turns = new Map();

const LINES = {
  station: [
    'Sure, here is where trotros from *{name}* go.',
    'Okay, *{name}* it is.',
    'Good one. Here is what runs from *{name}*.'
  ],
  stops: [
    'Here is the road from *{from}* to *{to}*, stop by stop.',
    'Okay, this is how the *{from}* to *{to}* car runs.',
    'Sure. These are the stops between *{from}* and *{to}*.'
  ],
  help: [
    'Of course, I am here to help.',
    'No wahala, I have you.',
    'Sure thing. Here is how I can help.'
  ],
  ask_fare: [
    'Sure, I can help with fares.',
    'No wahala, let us find your fare.'
  ],
  ask_fuel: [
    'Sure, let me check fuel prices for you.'
  ],
  ask_queue: [
    'Sure, let me check the queue for you.'
  ],
  ask_road: [
    'Sure, let me check the road for you.'
  ],
  pickLeg: [
    'Happy to. Which destination from *{name}*?',
    'Sure, which car from *{name}*?'
  ]
};

function fill(line, vars) {
  return line.replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null ? String(vars[k]) : ''));
}

/** One line of kind, rotating per rider so the same card does not open the same way twice. */
function line(kind, vars, hash) {
  const list = LINES[kind];
  if (!list) return '';
  const key = `${hash || ''}:${kind}`;
  const n = turns.get(key) || 0;
  turns.set(key, n + 1);
  if (turns.size > 5000) turns.clear();
  return fill(list[n % list.length], vars);
}

module.exports = { line, LINES };
