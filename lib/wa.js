/**
 * WHATSAPP CLOUD API — message builders.
 *
 * Every function returns the exact JSON body POSTed to
 *   https://graph.facebook.com/v21.0/{PHONE_NUMBER_ID}/messages
 *
 * Platform limits enforced here, not discovered in production:
 *   body text     1024 chars
 *   buttons       max 3, title 20 chars
 *   list rows     max 10 total, title 24 chars, description 72 chars
 *   list button   20 chars
 */

const LIMITS = { body: 1024, buttons: 3, buttonTitle: 20, rows: 10, rowTitle: 24, rowDesc: 72, listButton: 20 };

const clip = (s, n) => (s == null ? '' : String(s).length <= n ? String(s) : String(s).slice(0, n - 1) + '…');

function text(to, body, preview = false) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: preview, body: clip(body, LIMITS.body) }
  };
}

/** Up to 3 reply buttons. buttons: [{id,title}] */
function buttons(to, body, btns, header, footer) {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: clip(body, LIMITS.body) },
      action: {
        buttons: btns.slice(0, LIMITS.buttons).map(b => ({
          type: 'reply',
          reply: { id: b.id, title: clip(b.title, LIMITS.buttonTitle) }
        }))
      }
    }
  };
  if (header) payload.interactive.header = { type: 'text', text: clip(header, 60) };
  if (footer) payload.interactive.footer = { text: clip(footer, 60) };
  return payload;
}

/** Single-select list. sections: [{title, rows:[{id,title,description}]}] */
function list(to, body, buttonLabel, sections, header, footer) {
  let count = 0;
  const trimmed = sections.map(sec => ({
    title: clip(sec.title, 24),
    rows: sec.rows.filter(() => count++ < LIMITS.rows).map(r => ({
      id: r.id,
      title: clip(r.title, LIMITS.rowTitle),
      ...(r.description ? { description: clip(r.description, LIMITS.rowDesc) } : {})
    }))
  })).filter(s => s.rows.length);

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: clip(body, LIMITS.body) },
      action: { button: clip(buttonLabel, LIMITS.listButton), sections: trimmed }
    }
  };
  if (header) payload.interactive.header = { type: 'text', text: clip(header, 60) };
  if (footer) payload.interactive.footer = { text: clip(footer, 60) };
  return payload;
}

/** Asks the user to share their location — the zero-typing entry point. */
function locationRequest(to, body) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'location_request_message',
      body: { text: clip(body, LIMITS.body) },
      action: { name: 'send_location' }
    }
  };
}

/** Opens a published Flow — the closest thing to an embedded mini-app. */
function flow(to, { body, cta, flowId, flowToken, screen, data = {}, header, footer, mode = 'published' }) {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'flow',
      body: { text: clip(body, LIMITS.body) },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_token: flowToken,
          flow_id: flowId,
          flow_cta: clip(cta, 20),
          flow_action: 'navigate',
          mode,
          flow_action_payload: { screen, data }
        }
      }
    }
  };
  if (header) payload.interactive.header = { type: 'text', text: clip(header, 60) };
  if (footer) payload.interactive.footer = { text: clip(footer, 60) };
  return payload;
}

/**
 * Template message — REQUIRED for anything sent outside the 24h service
 * window. Every proactive add-on push uses one of these, and each must be
 * submitted to Meta for approval before use.
 */
function template(to, name, languageCode, bodyParams = []) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name,
      language: { code: languageCode || 'en' },
      components: bodyParams.length
        ? [{ type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: String(t) })) }]
        : []
    }
  };
}

function markRead(messageId) {
  return { messaging_product: 'whatsapp', status: 'read', message_id: messageId };
}

module.exports = { text, buttons, list, locationRequest, flow, template, markRead, LIMITS, clip };
