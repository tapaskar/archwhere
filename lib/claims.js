'use strict';
// archwhere claims: several agents on one task without collisions. A claim is an entry in the record,
// and the check-then-append happens under the record's lock, so on one filesystem a claim is atomic.
// Claims coordinate agents that cooperate: nothing here stops a process from ignoring them and pushing.

const crypto = require('crypto');
const R = require('./record');

const ROLES = ['builder', 'reviewer', 'tester'];
const WRITING_ROLES = ['builder', 'tester']; // reviewers read a branch; they don't hold it
const FINAL = ['done', 'released', 'failed'];
const DEFAULT_TTL_MIN = 30;
const MAX_TTL_MIN = 24 * 60;

function ttlMinutes(v) {
  if (v === undefined || v === null || v === '') return DEFAULT_TTL_MIN;
  let min = v;
  if (typeof v === 'string') {
    const m = v.match(/^(\d+)(s|m|h)?$/);
    if (!m) R.fail('invalid', 'ttl looks like 30m, 2h or 90s');
    min = Number(m[1]) * { s: 1 / 60, m: 1, h: 60 }[m[2] || 'm'];
  }
  if (typeof min !== 'number' || !(min >= 1 / 60) || min > MAX_TTL_MIN) R.fail('invalid', `ttl must be from 1 second to ${MAX_TTL_MIN} minutes`);
  return min;
}

/** Replay the record into claim state. Expiry is computed at read time from `now`. */
/** The same declared writer: attribution is self-declared, so this is identity as recorded. */
const sameWriter = (e, c) =>
  e.author === c.author && e.agent === c.agent && e.model === c.model && e.vendor === c.vendor;

function foldClaims(entries, now = Date.now()) {
  const claims = new Map();
  for (const e of entries) {
    if (e.type === 'claim' && typeof e.claim_id === 'string' && !claims.has(e.claim_id)) {
      claims.set(e.claim_id, {
        claim_id: e.claim_id, task: e.task, role: e.role, branch: e.branch, status: 'active',
        author: e.author, agent: e.agent, model: e.model, vendor: e.vendor,
        claimed_at: e.ts, expires_at: e.expires_at, takes_over: e.takes_over, entry: e.hash,
      });
    }
    if (e.type === 'claim-update' && claims.has(e.claim_id)) {
      const c = claims.get(e.claim_id);
      // Only the holder may move their own claim. The write path checks this, but the fold is
      // what a reader trusts, and an imported segment can carry an update nobody authorised.
      if (!sameWriter(e, c)) { (c.rejected = c.rejected || []).push({ entry: e.hash, why: 'not the holder' }); continue; }
      if (e.status) { c.status = e.status; c.ended_at = e.ts; c.note = e.note; }
      if (e.expires_at) {
        // A renewal may not reach further than one TTL past the moment it was written, so an
        // entry cannot grant itself a claim lasting years.
        const at = Date.parse(e.expires_at), from = Date.parse(e.ts);
        const cap = Number.isFinite(from) ? from + MAX_TTL_MIN * 60000 : NaN;
        if (Number.isFinite(at) && Number.isFinite(cap) && at > cap) {
          (c.rejected = c.rejected || []).push({ entry: e.hash, why: 'renewal beyond the maximum ttl' });
        } else {
          c.expires_at = e.expires_at; c.renewed_at = e.ts;
        }
      }
    }
  }
  // Date.parse of a malformed expires_at is NaN, and `now > NaN` is false, so the claim used to
  // stay active for ever. A claim whose expiry cannot be read is not a live claim: expire it.
  const expired = c => {
    const at = Date.parse(c.expires_at);
    return !Number.isFinite(at) || at <= now;
  };
  const all = [...claims.values()].map(c => (
    c.status === 'active' && expired(c) ? { ...c, status: 'expired' } : c
  ));
  return { all, active: all.filter(c => c.status === 'active'), conflicts: findConflicts(all) };
}

const writesBranch = c => c.branch && WRITING_ROLES.includes(c.role);

/**
 * Two active claims that can't both be right. Under one lock this never happens; it shows when records
 * from separate clones are imported. The earlier claim is listed first and is the one to honour.
 */
function findConflicts(all) {
  const active = all.filter(c => c.status === 'active');
  const out = [];
  active.forEach((a, i) => {
    for (const b of active.slice(i + 1)) {
      if (a.task === b.task && a.role === b.role) out.push({ kind: 'task-role', task: a.task, role: a.role, first: a.claim_id, second: b.claim_id });
      else if (writesBranch(a) && writesBranch(b) && a.branch === b.branch) out.push({ kind: 'branch', branch: a.branch, first: a.claim_id, second: b.claim_id });
    }
  });
  return out;
}

const holderText = c => `${c.agent} (claim ${c.claim_id}, until ${c.expires_at})`;

/**
 * Take a role on a task. Refused while someone else actively holds that role on the task, or a writing
 * claim on the branch. A builder can't also be the task's reviewer. Re-claiming what you already hold
 * returns the same claim. A claim past its expiry no longer counts, and the new claim records the takeover.
 */
function claim(dir, attr, { task, role, branch, ttl, note }, { now } = {}) {
  R.checkTask(task);
  if (!ROLES.includes(role)) R.fail('invalid', `role must be one of ${ROLES.join(', ')}`);
  if (branch !== undefined && branch !== null) R.checkBranch(branch);
  const minutes = ttlMinutes(ttl);
  const a = R.attribution(attr);
  return R.transact(dir, ctx => {
    const at = now !== undefined ? now : Date.now();
    const { all, active } = foldClaims(ctx.entries, at);
    const onTask = active.filter(c => c.task === task);
    const mine = onTask.find(c => c.role === role && c.agent === a.agent);
    if (mine && (!branch || mine.branch === branch)) return { claim: mine, already_held: true };
    const taken = onTask.find(c => c.role === role);
    if (taken) R.fail('conflict', `${role} on ${task} is held by ${holderText(taken)}`, { holder: taken });
    if (branch && WRITING_ROLES.includes(role)) {
      const writer = active.find(c => writesBranch(c) && c.branch === branch);
      if (writer) R.fail('conflict', `branch ${branch} already has a writer: ${holderText(writer)} on ${writer.task}`, { holder: writer });
    }
    if (role === 'reviewer' && onTask.some(c => c.role === 'builder' && c.agent === a.agent)) {
      R.fail('conflict', `${a.agent} is the builder on ${task} and can't also review it`);
    }
    const stale = all.filter(c => c.status === 'expired' && c.task === task && c.role === role).pop();
    const entry = ctx.add({
      type: 'claim', attr, task, role, branch: branch || undefined,
      claim_id: 'c-' + crypto.randomBytes(6).toString('hex'),
      expires_at: new Date(at + minutes * 60000).toISOString(),
      takes_over: stale ? stale.claim_id : undefined, note: note || undefined,
    });
    return { claim: foldClaims(ctx.entries, at).all.find(c => c.entry === entry.hash), already_held: false };
  });
}

function heldClaim(ctx, attr, claimId, at) {
  const a = R.attribution(attr);
  const c = foldClaims(ctx.entries, at).all.find(x => x.claim_id === claimId);
  if (!c) R.fail('not-found', `no claim ${String(claimId).slice(0, 40)}`);
  if (c.agent !== a.agent) R.fail('not-holder', `claim ${claimId} belongs to ${c.agent}`);
  return c;
}

/** Extend an active claim. An expired claim can't be renewed: someone may have taken over, so claim again. */
function renew(dir, attr, { claim_id, ttl }, { now } = {}) {
  const minutes = ttlMinutes(ttl);
  return R.transact(dir, ctx => {
    const at = now !== undefined ? now : Date.now();
    const c = heldClaim(ctx, attr, claim_id, at);
    if (c.status !== 'active') R.fail('expired', `claim ${claim_id} is ${c.status}; claim the task again`);
    ctx.add({ type: 'claim-update', attr, claim_id, task: c.task, expires_at: new Date(at + minutes * 60000).toISOString() });
    return { claim: foldClaims(ctx.entries, at).all.find(x => x.claim_id === claim_id) };
  });
}

/** End a claim with a final status: done, released or failed. */
function release(dir, attr, { claim_id, status = 'released', note }, { now } = {}) {
  if (!FINAL.includes(status)) R.fail('invalid', `status must be one of ${FINAL.join(', ')}`);
  return R.transact(dir, ctx => {
    const at = now !== undefined ? now : Date.now();
    const c = heldClaim(ctx, attr, claim_id, at);
    if (FINAL.includes(c.status)) R.fail('expired', `claim ${claim_id} is already ${c.status}`);
    ctx.add({ type: 'claim-update', attr, claim_id, task: c.task, status, note: note || undefined });
    return { claim: foldClaims(ctx.entries, at).all.find(x => x.claim_id === claim_id) };
  });
}

/** May this agent write to this branch? For a pre-push hook. `require` also demands a claim exists. */
function checkBranchWriter(entries, { branch, agent, require: must }, now = Date.now()) {
  R.checkBranch(branch);
  const writers = foldClaims(entries, now).active.filter(c => writesBranch(c) && c.branch === branch);
  const other = writers.find(c => c.agent !== agent);
  if (other) return { ok: false, reason: `branch ${branch} is held by ${holderText(other)}`, holder: other };
  if (must && !writers.length) return { ok: false, reason: `no active claim on branch ${branch}` };
  return { ok: true, reason: writers.length ? `${agent} holds ${branch}` : `nobody holds ${branch}` };
}

module.exports = { ROLES, WRITING_ROLES, FINAL, DEFAULT_TTL_MIN, MAX_TTL_MIN, ttlMinutes, foldClaims, claim, renew, release, checkBranchWriter };
