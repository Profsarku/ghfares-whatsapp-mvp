/**
 * BROADCAST — business-initiated messages, done properly.
 *
 * There is no broadcast endpoint in the Cloud API. You loop over recipients,
 * one template message each, and you live inside three constraints:
 *
 *   1. OPT-IN      every recipient must have opted in, and you must be able
 *                  to show when and how. Add-ons are that record.
 *   2. TEMPLATE    outside the 24h service window only approved templates go
 *                  out, and each is billed.
 *   3. TIER        messaging limits start at 250 unique recipients per 24h and
 *                  rise with quality. Blow through and sends silently fail.
 *
 * The fourth constraint is ours, not Meta's: an accountability product that
 * spams loses the trust it is selling. Frequency caps are enforced here.
 */

const caps = require('./capabilities');

/* Wire the consent ledger to every capability grant. */
caps.setGrantHook((hash, capId, method) => recordOptIn(hash, capId, method));

const TIERS = { unlimited: Infinity, tier3: 100000, tier2: 10000, tier1: 1000, tier0: 250 };

const CONFIG = {
  tier: 'tier0',            // start here; Meta raises it on quality
  batchSize: 40,            // per second, well under the API ceiling
  maxPerUserPerDay: 3,      // ours, not Meta's
  quietHours: [22, 5]       // no pushes 22:00–05:00 local
};

/* opt-in ledger — one row per grant, never overwritten */
const optIns = [];          // { hash, capability, at, method, source }
const sendLog = [];         // { hash, template, at }

function recordOptIn(hash, capability, method = 'keyword', source = 'whatsapp') {
  optIns.push({ hash, capability, at: new Date().toISOString(), method, source });
  return optIns[optIns.length - 1];
}
function optInProof(hash, capability) {
  return optIns.filter(o => o.hash === hash && o.capability === capability);
}

/* ── segments ── */
const SEGMENTS = {
  /** everyone holding a capability — the honest default */
  capability: (id) => caps.audience(id),

  /** holders of a capability whose saved route touches a station */
  station: (id, stationId) => caps.audience(id)
    .filter(s => s.station === stationId || (s.route && s.route.from === stationId)),

  /** holders whose saved route matches a corridor */
  corridor: (id, from, to) => caps.audience(id)
    .filter(s => s.route && s.route.from === from && s.route.to === to)
};

/* ── eligibility ── */
function withinQuietHours(d = new Date()) {
  const h = d.getHours(), [start, end] = CONFIG.quietHours;
  return start > end ? (h >= start || h < end) : (h >= start && h < end);
}
function sentToday(hash) {
  const cutoff = Date.now() - 86400000;
  return sendLog.filter(s => s.hash === hash && Date.parse(s.at) > cutoff).length;
}
function eligible(sub, capability) {
  if (!sub.caps.has(capability)) return { ok: false, reason: 'not opted in' };
  if (!optInProof(sub.hash, capability).length) return { ok: false, reason: 'no opt-in record' };
  if (sentToday(sub.hash) >= CONFIG.maxPerUserPerDay) return { ok: false, reason: 'frequency cap' };
  return { ok: true };
}

/**
 * Plan a broadcast without sending it. Always call this first — it shows the
 * audience, who is excluded and why, the batch schedule and the cost.
 */
function plan({ capability, template, params = [], segment = null, category = 'utility' }) {
  let audience = segment
    ? SEGMENTS[segment.type](capability, ...(segment.args || []))
    : SEGMENTS.capability(capability);

  const included = [], excluded = [];
  for (const sub of audience) {
    const e = eligible(sub, capability);
    (e.ok ? included : excluded).push({ hash: sub.hash, reason: e.reason });
  }

  const limit = TIERS[CONFIG.tier];
  const overTier = Math.max(0, included.length - limit);
  const batches = Math.ceil(Math.min(included.length, limit) / CONFIG.batchSize);

  return {
    template, category, capability,
    audience_total: audience.length,
    eligible: included.length,
    excluded: excluded.length,
    excluded_reasons: excluded.reduce((a, e) => (a[e.reason] = (a[e.reason] || 0) + 1, a), {}),
    tier: CONFIG.tier,
    tier_limit: limit === Infinity ? 'unlimited' : limit,
    deferred_over_tier: overTier,
    batches,
    seconds_to_complete: batches,
    quiet_hours_block: withinQuietHours(),
    estimated_messages: Math.min(included.length, limit),
    note: withinQuietHours()
      ? 'Quiet hours — held until 05:00'
      : 'Utility category. Marketing templates are throttled harder and cost more.',
    recipients: included.map(i => i.hash)
  };
}

/**
 * Execute a planned broadcast. Returns the payloads rather than sending them,
 * so the caller decides transport (and so a dry run is the default).
 */
function execute(planned, buildPayload) {
  if (planned.quiet_hours_block) return { sent: 0, held: planned.eligible, reason: 'quiet hours' };
  const out = [];
  planned.recipients.slice(0, planned.estimated_messages).forEach(hash => {
    out.push(buildPayload(hash));
    sendLog.push({ hash, template: planned.template, at: new Date().toISOString() });
  });
  return { sent: out.length, held: planned.eligible - out.length, payloads: out };
}

/* ── audit ── */
function ledger(hash) {
  return {
    opt_ins: hash ? optIns.filter(o => o.hash === hash) : optIns,
    sends_24h: hash ? sentToday(hash) : sendLog.length,
    config: CONFIG
  };
}

module.exports = { CONFIG, TIERS, SEGMENTS, recordOptIn, optInProof, plan, execute, ledger, optIns, sendLog };
