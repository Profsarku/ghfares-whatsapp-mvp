# GH Fares — WhatsApp MVP

Everyone talks to GH Fares through the HTTP API — riders, researchers, and
institutions. There is no web chat and no consumer website.

`POST /v1/ask` is the conversation. Lookups (`/v1/fares`, `/v1/fuel`, …) are
the same engine. WhatsApp and Messenger webhooks are optional adapters that
call `ask()` and deliver the reply; they are not a second product.

---

## Run it now

```bash
npm install
npm start                  # API on http://localhost:3000
node test/demo.js          # CLI conversation walkthrough
node test/demo.js --json   # with the exact Cloud API payloads
```

**http://localhost:3000** is the public site (services). **http://localhost:3000/go**
opens WhatsApp or Messenger on the phone — never a website chat. **http://localhost:3000/support**
is help and sharing. The API catalogue is **http://localhost:3000/v1**.

```bash
curl -s -X POST http://localhost:3000/v1/ask \
  -H "Content-Type: application/json" \
  -d "{\"text\":\"kaneshie to bubuashie\"}"
```

`DRY_RUN=true` prints every outbound Meta payload instead of sending it, so you
can develop the whole bot before touching Meta.

---

## The add-on system

WhatsApp has no extension store — you cannot install anything into someone's
WhatsApp. So add-ons live on the server. A rider sends `ADD FUEL` and their
subscriber record gains a capability; from then on the bot behaves differently
for them. Functionally an add-on, and it needs no permission from Meta.

| Command | What it changes |
|---|---|
| `ADD FUEL` | Cheapest fuel near them + an alert when a nearby station moves price |
| `ADD ROADS` | Incident alerts on roads they use |
| `ADD MY ROUTE` | Saves a default route — "how much" then needs no origin or destination |
| `ADD QUEUE` | Told when their loading bay turns slow or stuck |
| `ADD CHART` | New fares within hours of a GPRTU or operator revision |
| `ADD REPORT` | A bare number is a full report — route and station already known |
| `MY ADDONS` | See and manage everything active |
| `REMOVE FUEL` | Turn one off |

Registry lives in `lib/capabilities.js`. Add a capability there and it appears in
the bot, the Flow and the HTTP API automatically.

The same capabilities are exposed over HTTP so institutions can manage them:

```
GET    /v1/capabilities
GET    /v1/subscribers/:hash/capabilities
POST   /v1/subscribers/:hash/capabilities   { "capability": "fuel" }
DELETE /v1/subscribers/:hash/capabilities/:id
```

---

## Files

```
server.js                 Express: API catalogue + Meta adapters
lib/ask.js                POST /v1/ask — the conversation every client uses
public/go.html            Poster bounce — opens the phone apps, never the web
public/demo.html          Internal phone preview of API replies
public/demo.js            Preview client; talks to POST /v1/ask via /v1/demo/turn
lib/wa.js                 Cloud API message builders (text, buttons, list,
                          location request, Flow, template) with limits enforced
lib/api.js                Classifier + the data API every reply reads from
lib/engine.js             Conversation router; applies add-on capabilities
lib/capabilities.js       The add-on registry and subscriber store
flows/addons-flow.json    WhatsApp Flow JSON — the add-on manager as a mini-app
data/core.json            Stations with fares, fuel, incidents, queues, charts
test/demo.js              CLI walkthrough of the same engine
```

---

## Connect to Meta

1. **developers.facebook.com** → create an app → add the **WhatsApp** product.
   You get a test number, a `PHONE_NUMBER_ID` and a temporary token immediately.
2. Expose your server over HTTPS (`ngrok http 3000` while developing).
3. In the app dashboard → WhatsApp → Configuration → **Webhook**:
   - Callback URL `https://your-host/v1/webhook`
   - Verify token — whatever you set as `VERIFY_TOKEN`
   - Subscribe to the `messages` field
4. Set the environment:

```bash
export VERIFY_TOKEN=ghfares-verify
export WHATSAPP_TOKEN=EAAG...
export PHONE_NUMBER_ID=123456789
export WHATSAPP_APP_ID=1048759324622035   # Roader-Index
export APP_SECRET=...                     # App secret from that same app
export DRY_RUN=false
```

5. Message your test number. The webhook handles text, interactive taps,
   location shares and Flow completions.

---

## The fare table is real

`data/core.json` is built from the **Accra TroTro Apps Challenge field survey** —
surveyors rode the network in May–June 2015 and recorded the fare paid on one
trip per route.

```
tools/build-fare-table.py   survey CSVs → fare-table-2015.json + stops-accra.json
tools/merge-into-core.py    → data/core.json, with provenance attached
```

| | |
|---|---|
| Stations | 190 mapped, top 40 wired into the API |
| Routes | 651 surveyed, 608 with a recorded fare |
| Stops | 2,565 with coordinates |
| GPRTU branches | 104, named per route |
| Fares | GH₵0.50–9.00, median GH₵1.45 (2015 levels) |

**These are 2015 fares and the API says so.** Every trotro reply carries the
surveyed value, the route id and a warning that the figure is an inflation
re-based estimate, not an approved GPRTU chart. `chart_status` is
`estimate_pending_chart` on every row until a current chart is loaded.

This matters because no route-level fare dataset exists in Ghana. GPRTU
announces a **percentage**; the chart itself is a printed sheet displayed at
lorry stations. Journalists compile fare lists by photographing station boards.
So the survey is the only structured route-level fare data that exists — and
re-basing it is a stopgap, not a substitute for the chart.

**To make it authoritative:** photograph the fare boards at the top stations,
transcribe them, and set `chart_status` to `published` with a real
`effective_from`. The 2015 values stay as the historical series — which is
already the beginning of the index.

## Broadcasting

There is no broadcast endpoint in the Cloud API — you loop, one template per
recipient. `lib/broadcast.js` handles what Meta leaves to you.

```bash
GET  /v1/broadcasts/segments        who has opted into what
POST /v1/broadcasts                 DRY RUN — plan, audience, exclusions, cost
POST /v1/broadcasts?send=true       execute
GET  /v1/broadcasts/ledger/:hash    the consent record for one subscriber
```

**Opt-in is the add-on.** Every `ADD FUEL` writes a row to the consent ledger
with a timestamp and method. That is the record Meta asks for and most
businesses cannot produce — here it is a by-product of the product.

**Plan before you send.** A dry run returns the eligible audience, who was
excluded and why, batch count, tier headroom and whether quiet hours apply.
Nothing goes out without you seeing that first.

Four constraints are enforced:

| Constraint | Whose | Default |
|---|---|---|
| Opt-in with a written record | Meta's | required per capability |
| Approved template outside the 24h window | Meta's | 4 utility templates |
| Messaging tier — unique recipients per 24h | Meta's | starts at 250, rises on quality |
| Frequency cap and quiet hours | **ours** | 3 per user per day, none 22:00–05:00 |

That last row is not a platform rule. An accountability product that spams
loses the trust it is selling, and the quality rating that follows a block wave
drops your tier — so restraint is also self-interest.

Note: WhatsApp Business **app** Broadcast Lists (256 contacts, recipient must
have saved your number) are a different product and are not available through
the Cloud API.

## Entry — one link, one QR, two channels

A rider opens `/` or scans the QR, picks WhatsApp or Messenger, and lands in
that phone-app thread. Nothing to install either way.

```
GET  /                    chooser — WhatsApp, Messenger, and a QR of this page
GET  /go                  same page
GET  /v1/qr               printable SVG QR of the chooser
POST /v1/entry            beacon — which channel was chosen
GET  /v1/entry/stats      scan-to-choice funnel
```

- **Phone apps only.** `/` opens `whatsapp://` or `fb-messenger://` (Android
  intents). It never navigates to `wa.me` or `m.me`, which become websites on
  a desktop. On a computer the page stays put and tells the rider to scan the QR.
- **The QR is the start link**, not a station. Scanning it opens this chooser
  so the rider can pick WhatsApp or Messenger.
- **No pre-filled text on the WhatsApp link.** A `?text=` payload dismisses the
  ice breakers, and those are what teach a new user what to ask.
- **QR is generated server-side** by `tools/qr.js` — no dependency, no external
  service, and the URL is always this host.
- **Attribution is aggregate.** Views are counted at `/`, conversations at the
  webhook. The two are never linked per person.

Environment: `WA_NUMBER`, `FB_PAGE_USERNAME`, `FB_PAGE_ID`, `SITE_URL`.

## Two rider apps, one API

| Who | How they reach it |
|---|---|
| Riders | `POST /v1/ask` — same JSON as everyone else |
| Researchers / institutions | `GET /v1/*` and `POST /v1/ask` |

There is no consumer website. WhatsApp and Messenger, if connected, only call
`ask()` and forward the reply.

## Two channels, one engine

The engine emits WhatsApp Cloud API payloads. `lib/messenger.js` translates
them into Messenger Send API calls, so the router, classifier, add-ons and data
are shared. A new channel is another translator, not another bot.

| WhatsApp | Messenger |
|---|---|
| interactive list | quick replies (≤6 simple rows) or a card carousel |
| reply buttons | button template |
| location request | quick reply, `content_type: location` |
| slash commands | persistent menu (always visible) |
| ice breakers | greeting text + Get Started |
| `request_welcome` webhook | Get Started postback |
| utility template | tagged message |

```
GET  /v1/webhook/messenger      Meta verification
POST /v1/webhook/messenger      inbound messages, postbacks, quick replies, location
GET  /v1/messenger-profile      persistent menu + greeting + Get Started
POST /v1/messenger-profile      push it to the Page
```

Environment: `FB_PAGE_TOKEN`, `FB_VERIFY_TOKEN`.

Messenger's real advantage is the **persistent menu** — three top-level items
with submenus, visible at all times, where WhatsApp needs the user to know to
type `/`. Its disadvantage is reach in Ghana, and stricter rules on
business-initiated messages.

## Conversational Components — Meta's native widgets

Configured on the phone number, not sent as messages. This is what makes the
add-ons discoverable without an app store.

```bash
curl localhost:3000/v1/conversational-components      # see the config
curl -X POST localhost:3000/v1/conversational-components   # push it to Meta
```

Or set it in WhatsApp Manager → Phone Number → Automations.

**Commands** — a permanent slash menu. Typing `/` always shows it, so nobody has
to remember a keyword: `/where` `/fare` `/fuel` `/roads` `/addfuel` `/addroute`
`/addroads` `/myaddons` `/help` `/stop`.

**Ice breakers** — up to 4 tappable prompts, 80 characters each, no emoji, shown
only on a fresh thread. Tapping one sends it as an ordinary text message, so the
router handles it unchanged.

**Welcome message** — enabling it means Meta fires a `request_welcome` webhook
when someone opens a chat with no existing thread. `server.js` handles that type
and replies with the orientation and the add-on guide. It also opens the service
window, so the reply can be free-form.

Posters must not use a `wa.me?text=` link. That opens the website on desktop
and dismisses ice breakers. `/go` uses the WhatsApp app scheme with no pre-filled
text.

## Publishing the add-ons Flow

`flows/addons-flow.json` is a real Flow definition — a checkbox screen for the
add-ons, then an optional route picker.

1. WhatsApp Manager → **Flows** → Create flow → paste the JSON
2. Publish, copy the Flow ID
3. Send it with `wa.flow(...)` from `lib/wa.js`
4. On completion Meta posts an `interactive.nfm_reply`; `server.js` already
   parses it and applies the chosen capabilities

Flow JSON versions move — check the current version against Meta's docs before
publishing and bump the `version` field if needed.

---

## Message templates (required for add-on pushes)

Anything sent outside the 24-hour service window must be a pre-approved
template. Every proactive add-on push uses one. Submit these first — approval
takes days.

| Name | Category | Body |
|---|---|---|
| `fuel_price_change` | Utility | `{{1}} in {{2}} changed from {{3}} to {{4}} per litre.` |
| `road_incident` | Utility | `{{1}}: {{2}}. Expect {{3}}.` |
| `queue_state_change` | Utility | `{{1}} → {{2}}: queue is now {{3}}.` |
| `fare_chart_revision` | Utility | `{{1}} revised fares effective {{2}}. {{3}} is now {{5}}, was {{4}}.` |

Because these cost money per send, they fire only on genuine state change —
which is also why they stay useful instead of becoming a feed.

---

## API

Riders and institutions use the same endpoints.

```
POST /v1/ask                          { session?, text?, interactive_id?, location? }
                                      conversation — keep `session` for add-ons
GET  /v1/stations                     list
GET  /v1/stations/near?lat=&lng=      geofence resolve
GET  /v1/stations/:id/fares           every destination + chart + queue + gouging
GET  /v1/fares?from=&to=              pair lookup
GET  /v1/fuel?area=                   station prices, cheapest first
GET  /v1/fuel/compare?areas=Accra,Tema
GET  /v1/incidents?road=
POST /v1/reports/fare                 { station, dest, amount }
POST /v1/reports/queue                { station, dest, state }
POST /v1/nlu/classify                 { text } → intent + entities
GET  /v1/health/freshness             source ages, live incidents, subscribers
```

Every response carries a provenance envelope: `source` (`published` | `crowd` |
`both`), `authority`, `as_of`. That single field is what lets the same endpoint
answer a rider and be sold to an institution.

---

## The safety boundary

The classifier extracts **intent and entities only**. Every number in every
reply is looked up from the API afterwards. A model may be swapped in at the
`via: 'model'` branch in `lib/api.js` for phrasing the regex misses — but it
must return a station pair, never a price. The bot cannot invent a fare.

---

## Before production

- Replace the in-memory `subscribers` Map and `data/core.json` with Postgres
- Load real charts: NPA fuel window and GPRTU fare chart scrapers
- Hash MSISDNs with a secret salt (`server.js` `hashOf`) and never store the raw number
- Rate-limit `POST /v1/reports/*` per subscriber
- Add plausibility bounds on fare reports (reject outside 0.5×–5× chart)
- Verify Meta's current pricing rules before relying on service-window replies
