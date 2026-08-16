/* GH Fares phone demo — UI from the sample, turns from the live engine. */
const FROM = '233201234567';
const SESS = { wa: 'wa-preview-01' };

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const TICK = '<svg viewBox="0 0 18 14"><path d="M6.6 11.4L2.8 7.6l-1.2 1.2 5 5 1.1-1.1-1.1-1.3zm10.2-8.6l-7.9 8-1.6-1.6-1.2 1.2 2.8 2.8 9.1-9.2-1.2-1.2zM12 2.8l-1.2-1.2-5.2 5.3 1.2 1.2L12 2.8z"/></svg>';

let boot = null;
let CH = 'entry';
let busy = false;
let welcomed = false;

function now() {
  const d = new Date();
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}
function isFB() { return CH === 'fb'; }
function session() { return SESS.wa; }

$('#clock').textContent = now().replace(/ ?[ap]m/, '');

function fmt(t) {
  return esc(t)
    .replace(/```([\s\S]*?)```/g, (m, c) => '<pre>' + c.replace(/^\n/, '') + '</pre>')
    .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>');
}

const chat = $('#chat');
const scrollDown = () => { chat.scrollTop = chat.scrollHeight; };

function tail(side) {
  const c = side === 'in' ? '#202c33' : '#005c4b';
  return `<svg class="tail ${side === 'in' ? 'l' : 'r'}" viewBox="0 0 9 13">
    <path fill="${c}" d="${side === 'in' ? 'M9 0H1.5C.7 0 0 .6 0 1.4 0 4 3 8 9 13V0z' : 'M0 0h7.5c.8 0 1.5.6 1.5 1.4C9 4 6 8 0 13V0z'}"/></svg>`;
}

function bubble(html, side) {
  const row = document.createElement('div');
  row.className = 'row ' + side;
  const ticks = side === 'out' ? TICK : '';
  row.innerHTML = `<div class="bub ${side}">${tail(side)}${html}
    <span class="time">${now()}${ticks}</span></div>`;
  chat.appendChild(row);
  scrollDown();
  return row;
}

function systemChip(text, cls) {
  const d = document.createElement('div');
  d.className = cls || 'daychip';
  d.textContent = text;
  chat.appendChild(d);
  scrollDown();
}

function replyButtons(btns) {
  const d = document.createElement('div');
  d.className = 'btns';
  d.innerHTML = btns.map((b, i) =>
    `<button data-i="${i}"><svg viewBox="0 0 24 24"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>${esc(b.title)}</button>`
  ).join('');
  chat.appendChild(d);
  scrollDown();
  d.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
    const b = btns[+btn.dataset.i];
    d.querySelectorAll('button').forEach(x => x.disabled = true);
    send({ interactiveId: b.id, label: b.title });
  }));
}

function listMessage(label, sections) {
  const d = document.createElement('div');
  d.className = 'listbtn';
  d.innerHTML = `<svg viewBox="0 0 24 24"><path d="M3 5h2v2H3V5zm4 0h14v2H7V5zM3 11h2v2H3v-2zm4 0h14v2H7v-2zM3 17h2v2H3v-2zm4 0h14v2H7v-2z"/></svg>${esc(label)}`;
  d.setAttribute('role', 'button');
  d.tabIndex = 0;
  chat.appendChild(d);
  scrollDown();
  const open = () => openList(label, sections);
  d.addEventListener('click', open);
  d.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
}

function openList(label, sections) {
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.innerHTML = `<div class="sh"><b>${esc(label)}</b><button aria-label="Close">×</button></div>
    <div class="body">${sections.map(sec => `
      <div class="sectlabel">${esc(sec.title || '')}</div>
      ${sec.rows.map(r => `<button class="lrow" data-id="${esc(r.id)}" data-t="${esc(r.title)}">
        <span class="lt"><b>${esc(r.title)}</b>${r.description ? `<small>${esc(r.description)}</small>` : ''}</span>
        <span class="radio"></span></button>`).join('')}
    `).join('')}</div>`;
  const scrim = $('#scrim');
  scrim.innerHTML = '';
  scrim.appendChild(sheet);
  scrim.classList.add('show');
  const close = () => { scrim.classList.remove('show'); scrim.innerHTML = ''; };
  sheet.querySelector('.sh button').addEventListener('click', close);
  scrim.onclick = e => { if (e.target === scrim) close(); };
  sheet.querySelectorAll('.lrow').forEach(r => r.addEventListener('click', () => {
    close();
    send({ interactiveId: r.dataset.id, label: r.dataset.t });
  }));
}

function locationRequestButton() {
  const d = document.createElement('div');
  d.className = 'btns';
  d.innerHTML = `<button><svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 00-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 00-7-7zm0 9.5A2.5 2.5 0 1112 6.5a2.5 2.5 0 010 5z"/></svg>Send location</button>`;
  chat.appendChild(d);
  scrollDown();
  d.querySelector('button').addEventListener('click', () => { d.remove(); shareLocation(); });
}

function fbText(m) {
  bubble(esc(m.message.text), 'in');
  if (m.message.quick_replies) quickReplies(m.message.quick_replies);
}
function quickReplies(qrs) {
  const row = $('#qrow');
  row.innerHTML = qrs.map((q, i) =>
    `<button data-i="${i}">${q.content_type === 'location' ? '◎ Send location' : esc(q.title)}</button>`).join('');
  row.classList.add('show');
  row.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    const q = qrs[+b.dataset.i];
    row.classList.remove('show');
    row.innerHTML = '';
    if (q.content_type === 'location') return shareLocation();
    send({ interactiveId: q.payload, label: q.title });
  }));
}
function fbButtons(m) {
  const p = m.message.attachment.payload;
  bubble(esc(p.text), 'in');
  const d = document.createElement('div');
  d.className = 'row';
  d.innerHTML = `<div class="fbbtns" style="max-width:82%">${p.buttons.map((b, i) =>
    `<button data-i="${i}">${esc(b.title)}</button>`).join('')}</div>`;
  chat.appendChild(d);
  scrollDown();
  d.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
    const b = p.buttons[+btn.dataset.i];
    d.querySelectorAll('button').forEach(x => x.disabled = true);
    send({ interactiveId: b.payload, label: b.title });
  }));
}
function fbCarousel(m) {
  const els = m.message.attachment.payload.elements;
  const d = document.createElement('div');
  d.className = 'row';
  d.innerHTML = `<div class="carousel" style="max-width:100%">${els.map((e, i) =>
    `<div class="card"><div class="cbody"><b>${esc(e.title)}</b>${e.subtitle ? `<small>${esc(e.subtitle)}</small>` : ''}</div>
     <button data-i="${i}">${esc(e.buttons[0].title)}</button></div>`).join('')}</div>`;
  chat.appendChild(d);
  scrollDown();
  d.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => {
    const e = els[+btn.dataset.i];
    send({ interactiveId: e.buttons[0].payload, label: e.title });
  }));
}
function renderFB(m) {
  const a = m.message && m.message.attachment;
  if (!a) return fbText(m);
  if (a.payload.template_type === 'button') return fbButtons(m);
  if (a.payload.template_type === 'generic') return fbCarousel(m);
}

function templateCopy(name, a) {
  const T = {
    fuel_price_change: `*${a[0]}* in ${a[1]} changed from ${a[2]} to ${a[3]} per litre.`,
    road_incident: `*${a[0]}*: ${a[1]}. Expect ${a[2]}.`,
    queue_state_change: `*${a[0]} → ${a[1]}*: queue is now ${a[2]}.`,
    fare_chart_revision: `*${a[0]}* revised fares effective ${a[1]}.\n${a[2]} is now ${a[4]}, was ${a[3]}.`
  };
  return (T[name] || a.join(' · ')) + `\n_Reply STOP to turn this off._`;
}

function renderWA(p) {
  $('#qrow').classList.remove('show');
  if (p.type === 'text') return bubble(fmt(p.text.body), 'in');
  if (p.type === 'template') {
    const a = (p.template.components?.[0]?.parameters || []).map(x => x.text);
    return bubble(fmt(templateCopy(p.template.name, a)), 'in');
  }
  const i = p.interactive;
  if (!i) return;
  bubble(fmt(i.body.text) + (i.footer ? `\n<em>${esc(i.footer.text)}</em>` : ''), 'in');
  if (i.type === 'button') replyButtons(i.action.buttons.map(b => ({ id: b.reply.id, title: b.reply.title })));
  if (i.type === 'list') listMessage(i.action.button, i.action.sections);
  if (i.type === 'location_request_message') locationRequestButton();
  if (i.type === 'flow') replyButtons([{ id: '__flow', title: i.action.parameters.flow_cta }]);
}

function renderTurn(data) {
  if (isFB()) (data.messenger || []).forEach(renderFB);
  else (data.replies || []).forEach(renderWA);
}

async function turn(body) {
  const res = await fetch('/v1/demo/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: session(), channel: CH === 'web' ? 'web' : CH, ...body })
  });
  if (!res.ok) throw new Error('demo turn failed');
  return res.json();
}

async function resetSession() {
  await fetch('/v1/demo/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: SESS.wa })
  });
}

let send = async function ({ text, interactiveId, location, label, type }) {
  if (busy) return;
  if (interactiveId === '__flow') { systemChip('Flow opened — screens render inside WhatsApp'); return; }

  if (location) {
    const row = document.createElement('div');
    row.className = 'row out';
    row.innerHTML = `<div class="bub out" style="padding:3px">${tail('out')}
      <div class="locmsg"><div class="map">
        <svg viewBox="0 0 210 112"><rect width="210" height="112" fill="#1f3b30"/>
        <path d="M0 78 Q60 66 108 74 T210 62" stroke="#3d5c4c" stroke-width="7" fill="none"/>
        <path d="M52 112 Q66 60 92 26" stroke="#3d5c4c" stroke-width="5" fill="none"/>
        <circle cx="105" cy="56" r="16" fill="#00a884" opacity=".22"/>
        <circle cx="105" cy="56" r="6" fill="#00a884" stroke="#fff" stroke-width="2"/></svg>
      </div><div class="cap">Live location<small>Kaneshie Market area</small></div></div>
      <span class="time" style="position:absolute;right:10px;bottom:8px">${now()}${TICK}</span></div>`;
    chat.appendChild(row);
    scrollDown();
  } else if (label || text) {
    bubble(esc(label || text), 'out');
  }

  busy = true;
  $('#presence').textContent = 'typing…';
  const t = document.createElement('div');
  t.className = 'typing';
  t.innerHTML = '<i></i><i></i><i></i>';
  setTimeout(() => { chat.appendChild(t); scrollDown(); }, 220);

  try {
    const data = await turn({ text, interactiveId, location, type });
    await new Promise(r => setTimeout(r, 500));
    t.remove();
    $('#presence').textContent = isFB() ? 'Typically replies instantly' : 'online';
    busy = false;
    renderTurn(data);
  } catch (e) {
    t.remove();
    busy = false;
    $('#presence').textContent = 'online';
    systemChip('Could not reach the live engine — is the server running?');
  }
};

function shareLocation() {
  send({ location: { latitude: 5.5666, longitude: -0.2354 } });
}

$('#attach').addEventListener('click', () => {
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  const item = (label, color, path) =>
    `<button data-a="${label}"><span class="circ" style="background:${color}">
      <svg viewBox="0 0 24 24">${path}</svg></span>${label}</button>`;
  sheet.innerHTML = `<div class="attachgrid">
    ${item('Document', '#7f66ff', '<path d="M6 2h8l6 6v14H6V2zm7 1.5V9h5.5L13 3.5z"/>')}
    ${item('Camera', '#ff2e74', '<path d="M9 4l-1.5 2H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-3.5L15 4H9zm3 5a5 5 0 110 10 5 5 0 010-10z"/>')}
    ${item('Gallery', '#c93fd6', '<path d="M21 19V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5z"/>')}
    ${item('Audio', '#f2711c', '<path d="M12 2a3 3 0 00-3 3v6a3 3 0 006 0V5a3 3 0 00-3-3zm7 9a7 7 0 01-6 6.9V21h-2v-3.1A7 7 0 015 11h2a5 5 0 0010 0h2z"/>')}
    ${item('Location', '#20a35a', '<path d="M12 2a7 7 0 00-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 00-7-7zm0 9.5A2.5 2.5 0 1112 6.5a2.5 2.5 0 010 5z"/>')}
    ${item('Contact', '#0a7cff', '<path d="M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-5 0-9 2.5-9 5.5V22h18v-2.5c0-3-4-5.5-9-5.5z"/>')}
  </div>`;
  const scrim = $('#scrim');
  scrim.innerHTML = '';
  scrim.appendChild(sheet);
  scrim.classList.add('show');
  const close = () => { scrim.classList.remove('show'); scrim.innerHTML = ''; };
  scrim.onclick = e => { if (e.target === scrim) close(); };
  sheet.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', () => {
    close();
    if (b.dataset.a === 'Location') shareLocation();
    else systemChip(`${b.dataset.a} is not part of this demo`);
  }));
});

$('#send').addEventListener('click', () => {
  const v = $('#inp').value.trim();
  if (!v) return;
  $('#inp').value = '';
  send({ text: v });
});
$('#inp').addEventListener('keydown', e => { if (e.key === 'Enter') $('#send').click(); });

const iceWrap = $('#ice');
function showIceBreakers() {
  const prompts = (boot && boot.ice_breakers) || [];
  iceWrap.classList.remove('hide');
  iceWrap.innerHTML = prompts.map((t, i) => `<button class="ice" data-i="${i}">${esc(t)}</button>`).join('');
  iceWrap.querySelectorAll('.ice').forEach(b => b.addEventListener('click', () => {
    const label = prompts[+b.dataset.i];
    hideIceBreakers();
    send({ text: label });
  }));
}
function hideIceBreakers() { iceWrap.classList.add('hide'); iceWrap.innerHTML = ''; }

const cmdMenu = $('#cmdmenu');
function paintCommands(filter) {
  const q = (filter || '').replace(/^\//, '').toLowerCase();
  const rows = ((boot && boot.commands) || []).filter(c => c.command_name.startsWith(q));
  if (!rows.length) { cmdMenu.classList.remove('show'); return; }
  cmdMenu.innerHTML = `<div class="ch">Commands</div>` + rows.map(c =>
    `<button class="cmdrow" data-c="${c.command_name}"><b>/${c.command_name}</b><small>${esc(c.command_description)}</small></button>`
  ).join('');
  cmdMenu.classList.add('show');
  cmdMenu.querySelectorAll('.cmdrow').forEach(r => r.addEventListener('click', () => {
    cmdMenu.classList.remove('show');
    $('#inp').value = '';
    hideIceBreakers();
    send({ text: '/' + r.dataset.c, label: '/' + r.dataset.c });
  }));
}
$('#inp').addEventListener('input', e => {
  const v = e.target.value;
  if (v.startsWith('/')) paintCommands(v);
  else cmdMenu.classList.remove('show');
});
$('#inp').addEventListener('blur', () => setTimeout(() => cmdMenu.classList.remove('show'), 180));

const pmenu = $('#pmenu');
function paintPersistentMenu(items, title) {
  pmenu.innerHTML = (title ? `<div class="ph">${esc(title)}</div>` : '') + items.map((it, i) =>
    `<button class="pm" data-i="${i}">${esc(it.title)}${it.type === 'nested' ? '<span class="ch">›</span>' : ''}</button>`
  ).join('');
  pmenu.classList.add('show');
  pmenu.querySelectorAll('.pm').forEach(b => b.addEventListener('click', () => {
    const it = items[+b.dataset.i];
    if (it.type === 'nested') return paintPersistentMenu(it.call_to_actions, it.title);
    pmenu.classList.remove('show');
    send({ interactiveId: it.payload, label: it.title });
  }));
}
$('#fbmenu').addEventListener('click', () => {
  if (pmenu.classList.contains('show')) return pmenu.classList.remove('show');
  const items = boot && boot.messenger_profile && boot.messenger_profile.persistent_menu[0].call_to_actions;
  if (items) paintPersistentMenu(items);
});

let entryStation = 'kaneshie-mkt-cmplx';

function drawEntryQR(key) {
  const qrs = (boot && boot.qrs) || {};
  const q = qrs[key] || qrs._;
  if (!q) return;
  const m = q.m, n = m.length, s = 122 / n;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
    if (m[y][x]) d += `M${(x * s).toFixed(2)},${(y * s).toFixed(2)}h${s.toFixed(2)}v${s.toFixed(2)}h-${s.toFixed(2)}z`;
  $('#eQR').innerHTML = `<svg viewBox="0 0 122 122" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="QR code"><rect width="122" height="122" fill="#fff"/><path d="${d}" fill="#14181c"/></svg>`;
  $('#eQRp').textContent = q.slug ? '?s=' + q.slug : '';
  const named = !!(q.slug);
  $('#eAt').style.display = named ? '' : 'none';
  if (named) $('#eAtName').textContent = 'Scanned at ' + q.label;
}

function paintPicker() {
  const qrs = (boot && boot.qrs) || {};
  $('#ePick').innerHTML = Object.entries(qrs).map(([k, v]) =>
    `<button data-k="${k}" class="${k === entryStation ? 'on' : ''}">${esc(v.label)}</button>`).join('');
  $('#ePick').querySelectorAll('button').forEach(b => b.addEventListener('click', async () => {
    entryStation = b.dataset.k;
    await fetch('/v1/demo/station', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: SESS.wa, station: entryStation === '_' ? null : entryStation })
    });
    paintPicker();
    drawEntryQR(entryStation);
  }));
}

function enterChannel(ch) {
  $('#eChooser').style.display = 'none';
  $('#eRedir').classList.add('show');
  $('#eRedirMsg').textContent = 'Opening ' + (ch === 'wa' ? 'WhatsApp' : 'Messenger') + '…';
  setTimeout(() => {
    $('#eChooser').style.display = '';
    $('#eRedir').classList.remove('show');
    document.querySelector(`.switcher [data-ch="${ch}"]`).click();
  }, 900);
}
$('#eWA').addEventListener('click', () => enterChannel('wa'));
$('#eFB').addEventListener('click', () => enterChannel('fb'));

document.querySelectorAll('.switcher button').forEach(b => b.addEventListener('click', async () => {
  if (b.dataset.ch === CH) return;
  document.querySelectorAll('.switcher button').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  CH = b.dataset.ch;
  document.body.classList.toggle('fb-mode', CH === 'fb');
  document.body.classList.toggle('entry-mode', CH === 'entry');
  if (CH === 'entry') { pmenu.classList.remove('show'); return; }
  $('#presence').textContent = CH === 'fb' ? 'Typically replies instantly' : 'online';
  pmenu.classList.remove('show');
  cmdMenu.classList.remove('show');
  $('#qrow').classList.remove('show');
  chat.innerHTML = '';
  welcomed = false;
  busy = false;
  await resetSession();
  if (entryStation && entryStation !== '_') {
    await fetch('/v1/demo/station', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: SESS.wa, station: entryStation })
    });
  }
  if (CH === 'wa') startWA();
  else { hideIceBreakers(); startFB(); }
}));

function startWA() {
  systemChip('TODAY');
  const enc = document.createElement('div');
  enc.className = 'enc';
  enc.innerHTML = '🔒 Messages are end-to-end encrypted. This business works with other companies to manage this chat.';
  chat.appendChild(enc);
  setTimeout(async () => {
    showIceBreakers();
    if (welcomed) return;
    welcomed = true;
    systemChip('request_welcome · add-ons and menus first');
    $('#presence').textContent = 'typing…';
    try {
      const out = await turn({ type: 'request_welcome' });
      $('#presence').textContent = 'online';
      (out.replies || []).forEach(renderWA);
    } catch (e) {
      welcomed = false;
      $('#presence').textContent = 'online';
      systemChip('Could not reach the live engine — is the server running?');
    }
  }, 400);
}
function startFB() {
  systemChip('TODAY');
  bubble('<em>Approved fares, live station queues, fuel prices and road conditions across Ghana. Ask in your own words — no app, no account.</em>', 'in');
  const d = document.createElement('div');
  d.className = 'row';
  d.innerHTML = `<div class="fbbtns" style="max-width:82%"><button id="getstarted">Get Started</button></div>`;
  chat.appendChild(d);
  scrollDown();
  $('#getstarted').addEventListener('click', () => {
    d.remove();
    send({ interactiveId: 'menu', label: 'Get Started' });
  });
}

const origSend = send;
send = async function (args) {
  hideIceBreakers();
  $('#qrow').classList.remove('show');
  if (!welcomed) {
    welcomed = true;
    systemChip(isFB() ? 'Get Started · postback' : 'request_welcome · Meta fires this on a fresh thread');
    $('#presence').textContent = 'typing…';
    try {
      const out = await turn({ type: 'request_welcome' });
      await new Promise(r => setTimeout(r, 500));
      $('#presence').textContent = isFB() ? 'Typically replies instantly' : 'online';
      const replies = isFB() ? (out.messenger || []) : (out.replies || []);
      if (isFB()) {
        if (replies[0]) renderFB(replies[0]);
        await new Promise(r => setTimeout(r, 700));
        replies.slice(1).forEach(renderFB);
      } else {
        if (out.replies[0]) renderWA(out.replies[0]);
        await new Promise(r => setTimeout(r, 700));
        out.replies.slice(1).forEach(renderWA);
      }
      if (!(args.interactiveId === 'menu' && isFB())) {
        await new Promise(r => setTimeout(r, 500));
        await origSend(args);
      }
    } catch (e) {
      $('#presence').textContent = 'online';
      systemChip('Could not reach the live engine — is the server running?');
    }
    return;
  }
  return origSend(args);
};

(async function bootDemo() {
  document.body.classList.add('entry-mode');
  CH = 'entry';
  try {
    boot = await (await fetch('/v1/demo/bootstrap')).json();
    paintPicker();
    drawEntryQR(entryStation);
    if (entryStation !== '_') {
      await fetch('/v1/demo/station', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: SESS.wa, station: entryStation })
      });
    }
  } catch (e) {
    $('#eAtName').textContent = 'Start the server to load the live engine';
  }
})();
