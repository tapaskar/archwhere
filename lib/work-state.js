'use strict';
// archwhere work state: where a thread's task has got to, from the record and GitHub.
//
// Phase 4. The columns are derived on every read and never stored — a cache would be the second
// source of truth the whole design avoids.
//
// A task id is its GitHub issue number. `checkTask` already accepts bare digits, so the
// convention costs no schema change; the decision and the options it beat are in the record.
//
// Two things the review on #17 insisted on, and they shape everything here:
//
//   * These are not a pipeline. A PR can merge straight from Claimed. So a card sits at the
//     FURTHEST stage whose evidence matches the commit in play, and drops back when a new one
//     lands — rather than marching through six steps it was never going to take.
//
//   * Every chip says how it is known. `proved` means the hash chain or a signature carries it.
//     `declared` means an agent said so about itself. `observed` means GitHub reported it. The
//     board shows the word, so "Claimed by Claude" can never read as an identity that was checked.

const HOW = { PROVED: 'proved', DECLARED: 'declared', OBSERVED: 'observed' };

/** Columns in the order they are shown. `merged` is terminal; the rest are where evidence stops. */
const COLUMNS = ['proposed', 'claimed', 'in-pr', 'reviewed', 'signed-off', 'merged'];

const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The task id for a thread, under the convention: the issue number, as text. */
const taskOf = issueNumber => String(issueNumber);

/**
 * Where one task has got to.
 *
 * @param {object}   rec         { entries, verified, claims } from the record
 * @param {object}   thread      { number, title, components } — the GitHub issue
 * @param {object}   pr          the live PR for this task, or null. Never trusted from the
 *                               record: `work.pr` is self-declared and any agent can write a
 *                               work entry for a task it does not hold.
 * @param {function} independent review.independent, injected so this file stays pure
 */
function stateOf(rec, thread, pr, independent) {
  const task = taskOf(thread.number);
  const entries = (rec && rec.entries) || [];
  const notes = [];

  // Nothing derived from a record that does not verify. load() returns entries whether or not
  // they survived verify, and a column built on those would render edited history as fact.
  if (!rec || !rec.verified || !rec.verified.ok) {
    return { task, column: 'proposed', how: {}, notes: ['the record does not verify, so nothing is derived from it'], stale: false };
  }

  const mine = entries.filter(e => e.task === task);
  const work = mine.filter(e => e.type === 'work');
  const claims = ((rec.claims) || []).filter(c => c.task === task);

  // Only a builder claim means someone is building it; a reviewer claim is not the same thing.
  const building = claims.filter(c => c.role === 'builder' && c.status === 'active');
  const lapsed = claims.filter(c => c.role === 'builder' && c.status === 'expired');

  // The commit in play is what GitHub says the PR head is — observed, not declared. Falling back
  // to the newest work entry only when there is no PR to ask.
  const head = (pr && str(pr.headSha)) || (work.length ? str(work[work.length - 1].commit) : null);

  let column = 'proposed';
  const how = {};

  if (building.length) { column = 'claimed'; how.claimed = HOW.DECLARED; }
  else if (lapsed.length) notes.push(`last claimed by ${lapsed[lapsed.length - 1].agent}, expired`);

  if (pr) {
    column = 'in-pr';
    how['in-pr'] = HOW.OBSERVED;
    // A work entry naming a different commit is not evidence about this PR.
    if (work.length && head && !work.some(w => w.commit === head)) {
      notes.push('no work entry names the commit this PR is on');
    }
  } else if (work.length) {
    notes.push('a work entry claims a PR, but none was found on GitHub for this task');
  }

  if (head && independent) {
    const ind = independent(entries, { task, commit: head });
    if (ind && ind.ok) { column = 'reviewed'; how.reviewed = HOW.DECLARED; }
    else if (ind && ind.reasons && ind.reasons.length) notes.push(ind.reasons[0]);
  }

  // A sign-off is the one thing a signature proves. It names an entry, so resolve it through the
  // work entry for the commit in play; a sign-off on an older state says nothing about this one.
  const signed = (rec.verified.signoffs || []).filter(s => s.status === 'verified');
  const target = work.find(w => w.commit === head);
  const onThis = target ? signed.filter(s => s.target === target.hash) : [];
  const approve = onThis.filter(s => s.decision === 'approve');
  if (onThis.some(s => s.decision === 'reject')) {
    notes.push('an owner rejected this: a sign-off is not always an approval');
  } else if (approve.length) {
    column = 'signed-off';
    how['signed-off'] = HOW.PROVED;
  } else if (signed.length && !onThis.length && target) {
    notes.push('the sign-offs on record are for a different commit');
  }

  if (pr && pr.merged) { column = 'merged'; how.merged = HOW.OBSERVED; }

  return { task, column, how, notes, head, stale: !!(head && work.length && !work.some(w => w.commit === head)) };
}

/** Counts per column, for the strip above the map. */
function summarise(cards) {
  const out = Object.fromEntries(COLUMNS.map(c => [c, 0]));
  for (const c of cards) if (out[c.column] !== undefined) out[c.column] += 1;
  return out;
}

module.exports = { stateOf, summarise, taskOf, COLUMNS, HOW };
