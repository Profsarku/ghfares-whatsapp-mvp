/**
 * MESSENGER PLATFORM — builders, persistent menu, and a translator.
 *
 * The engine emits WhatsApp Cloud API payloads. Rather than fork the router,
 * this module translates those payloads into Messenger Send API calls. One
 * conversation logic, two phone apps. Institutions use the HTTP API.
 *
 * Platform limits enforced here:
 *   text                 2000 chars
 *   quick replies        13 max, title 20 chars
 *   button template      3 buttons, title 20 chars, text 640 chars
 *   generic template     10 elements, title 80, subtitle 80, 3 buttons each
 *   persistent menu      3 top-level items, nested submenus allowed
 */

const LIMITS = { text: 2000, quickReplies: 13, qrTitle: 20, buttons: 3, btnTitle: 20,
                 btnText: 640, elements: 10, elTitle: 80, elSubtitle: 80 };

const clip = (s, n) => (s == null ? '' : String(s).length <= n ? String(s) : String(s).slice(0, n - 1) + '…');

/* WhatsApp markup is not rendered by Messenger — strip it to plain text. */
const plain = s => String(s || '')
  .replace(/```([\s\S]*?)```/g, (m, c) => c.trim())
  .replace(/\*([^*\n]+)\*/g, '$1')
  .replace(/_([^_\n]+)_/g, '$1');

function text(psid, body, quickReplies) {
  const msg = { text: clip(plain(body), LIMITS.text) };
  if (quickReplies && quickReplies.length) {
    msg.quick_replies = quickReplies.slice(0, LIMITS.quickReplies).map(q =>
      q.location
        ? { content_type: 'location' }
        : { content_type: 'text', title: clip(q.title, LIMITS.qrTitle), payload: q.id });
  }
  return { recipient: { id: psid }, messaging_type: 'RESPONSE', message: msg };
}

function buttonTemplate(psid, body, btns) {
  return {
    recipient: { id: psid },
    messaging_type: 'RESPONSE',
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: clip(plain(body), LIMITS.btnText),
          buttons: btns.slice(0, LIMITS.buttons).map(b => ({
            type: 'postback', title: clip(b.title, LIMITS.btnTitle), payload: b.id
          }))
        }
      }
    }
  };
}

/** Rows become a scrollable card carousel — Messenger's closest thing to a list. */
function genericTemplate(psid, elements) {
  return {
    recipient: { id: psid },
    messaging_type: 'RESPONSE',
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'generic',
          image_aspect_ratio: 'square',
          elements: elements.slice(0, LIMITS.elements).map(e => ({
            title: clip(e.title, LIMITS.elTitle),
            subtitle: clip(e.subtitle || '', LIMITS.elSubtitle),
            buttons: [{ type: 'postback', title: clip(e.action || 'Choose', LIMITS.btnTitle), payload: e.id }]
          }))
        }
      }
    }
  };
}

/** Business-initiated. Messenger requires a tag or an opted-in recurring token. */
function taggedMessage(psid, body, tag = 'CONFIRMED_EVENT_UPDATE') {
  return {
    recipient: { id: psid },
    messaging_type: 'MESSAGE_TAG',
    tag,
    message: { text: clip(plain(body), LIMITS.text) }
  };
}

/* ═══════════ TRANSLATOR ═══════════ */

/**
 * WhatsApp payload → one or more Messenger Send API calls.
 * Where WhatsApp uses a list message, Messenger gets quick replies for small
 * sets and a card carousel for larger ones — the closest native equivalents.
 */
function fromWhatsApp(p, psid) {
  if (p.type === 'text') return [text(psid, p.text.body)];

  if (p.type === 'template') {
    const a = (p.template.components?.[0]?.parameters || []).map(x => x.text);
    return [taggedMessage(psid, `${p.template.name.replace(/_/g, ' ')}: ${a.join(' · ')}`)];
  }

  const i = p.interactive;
  if (!i) return [];

  if (i.type === 'button') {
    return [buttonTemplate(psid, i.body.text,
      i.action.buttons.map(b => ({ id: b.reply.id, title: b.reply.title })))];
  }

  if (i.type === 'list') {
    const rows = i.action.sections.flatMap(s => s.rows);
    if (rows.length <= 6 && rows.every(r => !r.description)) {
      return [text(psid, i.body.text, rows.map(r => ({ id: r.id, title: r.title })))];
    }
    return [
      text(psid, i.body.text),
      genericTemplate(psid, rows.map(r => ({
        id: r.id, title: r.title, subtitle: r.description, action: 'Choose'
      })))
    ];
  }

  if (i.type === 'location_request_message') {
    return [text(psid, i.body.text, [{ location: true }])];
  }

  if (i.type === 'flow') {
    return [buttonTemplate(psid, i.body.text,
      [{ id: '__flow', title: i.action.parameters.flow_cta }])];
  }

  return [];
}

/* ═══════════ PAGE WELCOME SCREEN ═══════════
   These are NOT injected by the website redirect. They live on the Page
   via POST /me/messenger_profile. Ice breakers are the tappable chips on
   a new Page thread (max 4). They take precedence over Get Started.
   Persistent menu is the hamburger in the composer, not the welcome chips. */

function messengerProfile() {
  return {
    get_started: { payload: 'menu' },
    greeting: [{
      locale: 'default',
      text: 'Approved fares, live station queues, fuel prices and road conditions across Ghana. Ask in your own words — no app, no account.'
    }],
    ice_breakers: [{
      locale: 'default',
      call_to_actions: [
        { question: 'Add-ons and menus', payload: 'menu' },
        { question: 'Fares from my station', payload: 'loc' },
        { question: 'Fuel prices near me', payload: 'ask:fuel' },
        { question: 'Road conditions right now', payload: 'ask:road' }
      ]
    }],
    persistent_menu: [{
      locale: 'default',
      composer_input_disabled: false,
      call_to_actions: [
        { type: 'postback', title: 'Where am I?', payload: 'loc' },
        { type: 'postback', title: 'Add-ons', payload: 'addon:menu' },
        { type: 'postback', title: 'How to talk to me', payload: 'help' }
      ]
    }]
  };
}

module.exports = { text, buttonTemplate, genericTemplate, taggedMessage,
                   fromWhatsApp, messengerProfile, LIMITS, plain, clip };
