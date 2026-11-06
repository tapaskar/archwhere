'use strict';
// archwhere review check: did a different vendor's different model approve this work?
// All of it rests on what agents DECLARED about themselves. It catches honest mistakes and routing slips;
// it can't catch an agent that lies about its vendor. Orchestrating reviews is deliberately not here.

const R = require('./record');
const { foldClaims } = require('./claims');

const NOTE = 'vendor and model are self-declared; this checks what was recorded, not what actually ran';
const UNKNOWN = new Set(['', 'unknown', 'none', 'n/a', 'na', 'unspecified', 'tbd']);

// A model name that gives away its maker catches "vendor: aws" on a Claude model. Vendor means who made
// the model, not who hosted it, since a hosted copy shares the maker's blind spots.
const MAKERS = [
  [/\bclaude\b|anthropic/, 'anthropic'], [/\bgpt\b|gpt-|\bo[134]\b|\bo[134]-|openai|codex/, 'openai'],
  [/gemini|gemma/, 'google'], [/llama/, 'meta'], [/\bnova\b|amazon\.|titan/, 'amazon'], [/grok/, 'xai'],
  [/mistral|mixtral|codestral/, 'mistral'], [/qwen/, 'alibaba'], [/deepseek/, 'deepseek'], [/\bcommand-|cohere/, 'cohere'],
  [/\bkimi\b|moonshot/, 'moonshot'], [/\bglm\b|glm-/, 'zhipu'],
];

const norm = s => String(s || '').trim().toLowerCase();
const makerOf = model => { const m = norm(model); const hit = MAKERS.find(([re]) => re.test(m)); return hit ? hit[1] : null; };

/** The vendor to compare: the maker implied by the model name, else the declared vendor. */
function effectiveVendor(p) {
  if (p.actor === R.HUMAN || p.vendor === R.HUMAN) return R.HUMAN;
  return makerOf(p.model) || norm(p.vendor);
}

const person = e => ({ actor: e.actor, author: e.author, agent: e.agent, model: e.model, vendor: e.vendor, vendor_compared: effectiveVendor(e) });

function compare(reviewer, authors) {
  const why = [];
  const rv = effectiveVendor(reviewer);
  if (UNKNOWN.has(rv) || UNKNOWN.has(norm(reviewer.model))) why.push('reviewer declares no usable vendor or model');
  for (const a of authors) {
    const av = effectiveVendor(a);
    if (rv !== R.HUMAN && UNKNOWN.has(av)) why.push(`author ${a.agent} declares no usable vendor`);
    if (rv === av && rv !== R.HUMAN) why.push(`same vendor as author ${a.agent}: ${rv}`);
    if (rv !== R.HUMAN && norm(reviewer.model) === norm(a.model)) why.push(`same model as author ${a.agent}: ${a.model}`);
    if (norm(reviewer.agent) === norm(a.agent) && rv !== R.HUMAN) why.push(`same agent as the author: ${a.agent}`);
    if (rv === R.HUMAN && a.actor === R.HUMAN && norm(reviewer.author) === norm(a.author)) why.push(`the same person, ${a.author}, wrote and reviewed it`);
  }
  const maker = makerOf(reviewer.model);
  if (maker && reviewer.actor !== R.HUMAN && norm(reviewer.vendor) !== maker) {
    why.push(`note: declared vendor "${reviewer.vendor}" but the model name points to ${maker}; compared as ${maker}`);
  }
  return why;
}

/**
 * Is there an independent approval? For a `target` entry, its author is the author. For a `task`, the
 * authors are every builder claim and `work` entry on it. Only an `approve` review counts, and only if
 * recorded after the newest work: a review of an older state is reported as stale. `commit`, if given,
 * must match the review's commit.
 */
function independent(entries, { task, target, commit } = {}) {
  if (!task && !target) R.fail('invalid', 'give --task or --target');
  let authors = []; let reviews = []; let lastWork = -1;
  const pos = new Map(entries.map((e, i) => [e.hash, i]));
  if (target) {
    const t = R.mustFind(entries, target, 'target');
    authors = [t];
    reviews = entries.filter(e => e.type === 'review' && e.target === t.hash);
    lastWork = pos.get(t.hash);
  } else {
    R.checkTask(task);
    const claims = foldClaims(entries).all.filter(c => c.task === task && c.role === 'builder');
    const work = entries.filter(e => e.type === 'work' && e.task === task);
    const claimEntries = entries.filter(e => claims.some(c => c.entry === e.hash));
    authors = [...claimEntries, ...work];
    reviews = entries.filter(e => e.type === 'review' && e.task === task);
    lastWork = work.length ? pos.get(work[work.length - 1].hash) : -1;
  }
  const seen = new Set();
  authors = authors.filter(a => { const k = `${a.agent}|${a.model}|${a.vendor}|${a.author}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const reasons = [];
  if (!authors.length) reasons.push(`no declared author for ${task || target}: no builder claim or work entry`);
  if (!reviews.length) reasons.push('no review recorded');
  // A reviewer who approves and then asks for changes has not approved. Only their newest verdict
  // counts, or a stale approve outlives the objection that replaced it.
  const newest = new Map();
  for (const r of reviews) newest.set(`${r.agent}|${r.model}|${r.vendor}|${r.author}`, r);
  const current = new Set([...newest.values()].map(r => r.hash));

  const judged = reviews.map(r => {
    const why = [];
    if (r.verdict !== 'approve') why.push(`verdict is "${r.verdict}"`);
    if (!current.has(r.hash)) why.push('superseded: this reviewer recorded a later verdict');
    if (pos.get(r.hash) < lastWork) why.push('stale: work was recorded after this review');
    if (commit && r.commit !== commit) why.push(`reviewed commit ${r.commit || '(none declared)'}, not ${commit}`);
    // A task spans many commits. A review scoped to one, naming neither a commit nor a target
    // entry, cannot say what it looked at — so it cannot certify it. A target-scoped review is
    // already specific, and the staleness rule above only catches this when work was recorded
    // afterwards: a push nobody wrote a `work` entry for would leave it certifying for ever.
    else if (!commit && !r.commit && !r.target) {
      why.push('does not say what it reviewed: no commit and no target entry');
    }
    const mismatch = compare(r, authors);
    const blocking = [...why, ...mismatch.filter(w => !w.startsWith('note:'))];
    return { ...person(r), hash: r.hash, verdict: r.verdict, commit: r.commit, independent: !blocking.length, why: [...why, ...mismatch] };
  });
  const passing = judged.filter(j => j.independent);
  if (reviews.length && !passing.length) reasons.push('no review is both an approval and independent of the authors');
  const unsigned = passing.filter(p => p.actor === R.HUMAN);
  return {
    ok: !!(authors.length && passing.length), authors: authors.map(person), reviews: judged, reasons,
    note: NOTE + (unsigned.length ? '; a "human" reviewer is unverified unless an owner sign-off covers it' : ''),
  };
}

module.exports = { independent, effectiveVendor, makerOf, NOTE };
