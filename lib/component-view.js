'use strict';
// archwhere component view: what the record says about one component, read-only.
//
// Phase 5 of the board plan, in the order the review asked for: the read-only panels first, the
// decision button last. Nothing here writes, and the mission server still only writes to GitHub.
//
// Pure — entries in, panel out. The rules it exists to hold:
//
//   * Nothing is shown unless the chain verifies. `load()` returns entries whether or not they
//     survived `verify`, so a panel built straight off it would render edited history as fact.
//   * Everything in the record is DECLARED. An agent writes its own author, model and vendor, and
//     the chain proves only that the line has not changed since it was written. The panel says so
//     rather than letting a name imply an identity.
//   * A corrected finding is not a current finding. If a `correction` entry points at one, it is
//     marked and ranked below the rest, never silently dropped — the correction is the evidence.
//   * One checkout's record is not the project's record. The panel carries the segment count and
//     says where it is reading from, so "no spec" cannot be read as "there is no spec".

const MAX_TEXT = 2000;     // one entry's body, as shown
const MAX_FINDINGS = 20;   // per component

const clip = (s, n = MAX_TEXT) => {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + '…' : t;
};

/** Who wrote it, flagged as declared: the chain proves the line is unchanged, not who typed it. */
function declaredBy(e) {
  return {
    author: clip(e.author, 80), agent: clip(e.agent, 80),
    model: clip(e.model, 80), vendor: clip(e.vendor, 80),
    declared: true,
  };
}

/** hash -> the corrections aimed at it. */
function correctionsByTarget(entries) {
  const out = new Map();
  for (const e of entries) {
    if (e.type !== 'correction' || !e.corrects) continue;
    if (!out.has(e.corrects)) out.set(e.corrects, []);
    out.get(e.corrects).push(e);
  }
  return out;
}

/**
 * Findings on one component, newest first, each saying whether something later corrected it.
 * A corrected finding sorts last: still visible, because the pair is the useful record, but it
 * should not sit above a live one.
 */
function findingsFor(entries, component, { limit = MAX_FINDINGS } = {}) {
  const corrections = correctionsByTarget(entries);
  const mine = entries.filter(e => e.type === 'finding' && (e.components || []).includes(component));
  return mine
    .map(e => {
      const fixes = corrections.get(e.hash) || [];
      return {
        hash: e.hash, ts: e.ts, title: clip(e.title, 300), body: clip(e.body), task: e.task,
        corrected: fixes.length > 0,
        corrections: fixes.map(c => ({ hash: c.hash, ts: c.ts, body: clip(c.body, 600), ...declaredBy(c) })),
        ...declaredBy(e),
      };
    })
    .sort((a, b) => (a.corrected === b.corrected ? String(b.ts).localeCompare(String(a.ts))
                                                 : (a.corrected ? 1 : -1)))
    .slice(0, limit);
}

/**
 * What the record holds about one component.
 * `verified` is the result of R.verify; when it fails, nothing derived is returned — a panel that
 * renders unverified entries is worse than a panel that says it cannot vouch for them.
 */
function componentView(entries, component, { verified, listSpecs, limit } = {}) {
  const segments = (verified && Array.isArray(verified.segments)) ? verified.segments.length : 0;
  const provenance = {
    from: "this checkout's record",
    segments,
    note: segments > 1
      ? 'entries from clones that were never imported are not here'
      : 'one segment: entries from other clones are not here unless imported',
  };

  if (!verified || !verified.ok) {
    return {
      component, ok: false, provenance,
      reason: 'the record does not verify, so nothing derived from it is shown',
      problems: ((verified && verified.errors) || []).slice(0, 5).map(e => `${e.kind}: ${e.detail}`),
      specs: [], findings: [],
    };
  }

  const specs = (listSpecs ? listSpecs(entries, { component }) : []).map(s => ({
    ...s, title: clip(s.title, 300), declared: true,
  }));

  return {
    component, ok: true, provenance,
    specs,
    specsEmpty: specs.length ? null : 'no spec in this record',
    findings: findingsFor(entries, component, { limit }),
  };
}

module.exports = { componentView, findingsFor, correctionsByTarget, declaredBy, MAX_TEXT, MAX_FINDINGS };
