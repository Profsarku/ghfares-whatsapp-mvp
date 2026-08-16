/**
 * User API — everyone talks to GH Fares through this.
 * WhatsApp and Messenger webhooks are adapters that call ask() and
 * deliver the same replies over Meta. They are not a second product.
 */
const crypto = require('crypto');
const { classify } = require('./api');
const engine = require('./engine');
const caps = require('./capabilities');

const hashOf = id =>
  crypto.createHash('sha256').update('ghfares:' + id).digest('hex').slice(0, 16);

function newSession() {
  return crypto.randomBytes(8).toString('hex');
}

function toPlain(payloads) {
  return (payloads || []).map(p => {
    if (p.type === 'text') return { type: 'text', body: p.text.body };
    if (p.type === 'template') {
      const params = (p.template.components?.[0]?.parameters || []).map(x => x.text);
      return { type: 'alert', template: p.template.name, params };
    }
    const i = p.interactive;
    if (!i) return { type: 'unknown' };
    if (i.type === 'button') {
      return {
        type: 'buttons',
        body: i.body.text,
        footer: i.footer ? i.footer.text : undefined,
        buttons: i.action.buttons.map(b => ({ id: b.reply.id, title: b.reply.title }))
      };
    }
    if (i.type === 'list') {
      return {
        type: 'list',
        body: i.body.text,
        footer: i.footer ? i.footer.text : undefined,
        button: i.action.button,
        rows: i.action.sections.flatMap(s => s.rows.map(r => ({
          id: r.id, title: r.title, description: r.description || ''
        })))
      };
    }
    if (i.type === 'location_request_message') {
      return { type: 'location_request', body: i.body.text };
    }
    if (i.type === 'flow') {
      return { type: 'flow', body: i.body.text, cta: i.action.parameters.flow_cta };
    }
    return { type: i.type, body: i.body && i.body.text };
  });
}

/**
 * @param {{ session?: string, from?: string, text?: string, interactiveId?: string, location?: {latitude:number,longitude:number}, type?: string }} input
 */
function ask(input = {}) {
  const session = input.session || newSession();
  const from = input.from || session;
  const hash = input.hash || (input.from ? hashOf(input.from) : hashOf('api:' + session));
  const parsed = input.text != null ? classify(input.text) : {
    intent: input.type || (input.interactiveId ? 'tap' : input.location ? 'where' : null),
    places: [],
    via: 'api'
  };
  const payloads = engine.handle({
    from,
    hash,
    text: input.text,
    interactiveId: input.interactiveId,
    location: input.location,
    type: input.type
  });
  const sub = caps.subscriber(hash);
  return {
    session,
    hash,
    intent: parsed.intent,
    places: parsed.places || [],
    via: parsed.via || 'api',
    replies: toPlain(payloads),
    payloads,
    subscriber: {
      capabilities: [...sub.caps],
      station: sub.station,
      route: sub.route
    }
  };
}

module.exports = { ask, toPlain, hashOf, newSession };
