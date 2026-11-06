'use strict';
// archwhere runtime signals: normalise what a runtime endpoint reports, and grade it.
// Pure — no network, no fs, no clock of its own. The endpoint is the user's to write; this file
// decides only what a reading means, so the rule lives in one place and is tested.
//
// Two rules are deliberate and the rest follows from them:
//   1. An error count with no denominator is not a signal. 212 failures out of 300 is an outage;
//      212 out of two million is noise. Counts without `of` are shown, never graded.
//   2. Unknown is not ok. A component that reports nothing, or whose reading has gone stale, must
//      not render as healthy — the board's old UI fell back to green for any status it did not
//      recognise, which is how a service can be dead for hours and look fine.

const STATUSES = ['ok', 'warn', 'bad', 'unknown'];
const RANK = { unknown: 0, ok: 1, warn: 2, bad: 3 };

/** Beyond this, a reading is too old to mean anything. */
const STALE_MS = 120000;

/** Error-rate bands, as a fraction of traffic. Per-component overrides win. */
const BANDS = { warn: 0.01, bad: 0.05 };

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The fraction of traffic that failed, or null when there is no denominator to divide by. */
function errorRate(errors) {
  if (!errors || typeof errors !== 'object') return null;
  const value = num(errors.value);
  const of = num(errors.of);
  if (value === null || of === null || of <= 0 || value < 0) return null;
  return value / of;
}

/** Worst of the statuses given; unknown loses to everything, so a partial reading still grades. */
function worst(list) {
  let out = 'unknown';
  for (const s of list) {
    if (!STATUSES.includes(s)) continue;
    if (RANK[s] > RANK[out]) out = s;
  }
  return out;
}

/**
 * Grade one component from what it reported.
 * `bands` may be given per component so a chatty service and a quiet one are not held to one number.
 */
function grade(c, bands = BANDS) {
  if (!c || typeof c !== 'object') return 'unknown';
  const votes = [];

  // A status the endpoint states itself is respected, but an unrecognised one is unknown, never ok.
  const stated = str(c.status);
  if (stated) votes.push(STATUSES.includes(stated) ? stated : 'unknown');

  const rate = errorRate(c.signals && c.signals.errors);
  if (rate !== null) votes.push(rate >= bands.bad ? 'bad' : rate >= bands.warn ? 'warn' : 'ok');

  for (const f of Array.isArray(c.failures) ? c.failures : []) {
    const sev = str(f && f.severity);
    if (sev && STATUSES.includes(sev)) votes.push(sev);
  }

  return votes.length ? worst(votes) : 'unknown';
}

/** "11.5 % of 1,840 req/h" — the denominator is the point, so it is always shown. */
function rateLine(signals) {
  const rate = errorRate(signals && signals.errors);
  if (rate === null) return null;
  const of = num(signals.errors.of);
  const unit = str(signals.traffic && signals.traffic.unit) || '';
  const pct = rate >= 0.1 ? (rate * 100).toFixed(1) : (rate * 100).toFixed(2);
  return `${pct} % of ${of.toLocaleString('en-GB')}${unit ? ' ' + unit : ''}`;
}

/**
 * Normalise a runtime payload for the board.
 * `now` and `staleMs` are arguments so this stays pure and the staleness rule is testable.
 */
function normalize(raw, { now = Date.now(), staleMs = STALE_MS, bands = BANDS } = {}) {
  if (!raw || typeof raw !== 'object' || !raw.components || typeof raw.components !== 'object') {
    return { ok: false, reason: 'runtime payload has no components', components: {} };
  }

  // A reading from ten minutes ago is not news. Age the whole payload, not each component:
  // the endpoint reports once, so one timestamp governs all of it.
  const generatedMs = Date.parse(raw.generated || raw.generatedAt || '');
  const age = Number.isFinite(generatedMs) ? now - generatedMs : null;
  const stale = age !== null && age > staleMs;

  const components = {};
  for (const [id, c0] of Object.entries(raw.components)) {
    const c = c0 && typeof c0 === 'object' ? c0 : {};
    const lines = (Array.isArray(c.lines) ? c.lines : []).map(String);
    const failures = (Array.isArray(c.failures) ? c.failures : [])
      .filter(f => f && typeof f === 'object')
      .map(f => ({
        name: str(f.name) || 'failure',
        count: num(f.count),
        window: str(f.window),
        severity: STATUSES.includes(str(f.severity)) ? str(f.severity) : null,
      }));

    const status = stale ? 'unknown' : grade(c, (c.bands && typeof c.bands === 'object') ? { ...bands, ...c.bands } : bands);
    const rate = rateLine(c.signals);

    components[id] = {
      status,
      lines: stale ? lines.concat('reading is stale') : lines,
      failures,
      rate,                                   // null when errors came without a denominator
      deploy: c.deploy && typeof c.deploy === 'object'
        ? { at: str(c.deploy.at), ref: str(c.deploy.ref) } : null,
      links: (Array.isArray(c.links) ? c.links : [])
        .filter(l => l && typeof l === 'object' && /^https?:\/\//.test(String(l.url)))
        .map(l => ({ label: str(l.label) || 'open', url: String(l.url) })),
    };
  }

  return { ok: true, stale, ageMs: age, components };
}

/**
 * The attention rail's share of the runtime: components worth interrupting someone for,
 * worst first. `unknown` is included — not knowing is a state to act on, not to ignore.
 */
function attention(normalized) {
  if (!normalized || !normalized.ok) return [];
  return Object.entries(normalized.components)
    .filter(([, c]) => c.status === 'bad' || c.status === 'warn' || c.status === 'unknown')
    .map(([id, c]) => ({
      id,
      status: c.status,
      why: c.failures.length
        ? c.failures.map(f => f.name + (f.count !== null ? ' ' + f.count.toLocaleString('en-GB') : '')
            + (f.window ? ' / ' + f.window : '')).join(' · ')
        : (c.rate ? 'errors ' + c.rate : c.lines.join(' · ')),
      deploy: c.deploy,
    }))
    .sort((a, b) => RANK[b.status] - RANK[a.status] || a.id.localeCompare(b.id));
}

module.exports = { normalize, grade, errorRate, rateLine, attention, worst, STATUSES, STALE_MS, BANDS };
