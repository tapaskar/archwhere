'use strict';
const test = require('node:test');
const assert = require('node:assert');
const W = require('../lib/work-state');

const OK = { ok: true, signoffs: [] };
const thread = { number: 42, title: 'SLA clock ignores holidays', components: ['tickets'] };
const who = { author: 'dana', agent: 'b1', model: 'claude-opus-5', vendor: 'anthropic' };
const work = (hash, commit) => ({ type: 'work', hash, task: '42', commit, ...who, ts: '2026-11-06T01:00:00Z' });
const claim = (role, status) => ({ claim_id: 'c1', task: '42', role, status, agent: 'b1', expires_at: '2026-11-06T09:00:00Z' });
const rec = (o = {}) => ({ entries: [], verified: OK, claims: [], ...o });
const yes = () => ({ ok: true, reasons: [] });
const no = (why = 'no review recorded') => ({ ok: false, reasons: [why] });

test('the task id is the issue number, as text', () => {
  assert.strictEqual(W.taskOf(42), '42');
  assert.strictEqual(W.stateOf(rec(), thread, null, no).task, '42');
});

test('a record that does not verify derives nothing', () => {
  // load() hands back entries whether or not they survived verify.
  const r = rec({ verified: { ok: false, errors: [] }, entries: [work('w1', 'abc1234')], claims: [claim('builder', 'active')] });
  const s = W.stateOf(r, thread, { headSha: 'abc1234' }, yes);
  assert.strictEqual(s.column, 'proposed');
  assert.match(s.notes[0], /does not verify/);
});

test('a thread with nothing against it is proposed', () => {
  assert.strictEqual(W.stateOf(rec(), thread, null, no).column, 'proposed');
});

test('only a builder claim means someone is building it', () => {
  const reviewer = W.stateOf(rec({ claims: [claim('reviewer', 'active')] }), thread, null, no);
  assert.strictEqual(reviewer.column, 'proposed', 'a reviewer claim is not building');
  const builder = W.stateOf(rec({ claims: [claim('builder', 'active')] }), thread, null, no);
  assert.strictEqual(builder.column, 'claimed');
  assert.strictEqual(builder.how.claimed, 'declared', 'an agent said so about itself');
});

test('an expired claim does not hold the card, and says who had it', () => {
  const s = W.stateOf(rec({ claims: [claim('builder', 'expired')] }), thread, null, no);
  assert.strictEqual(s.column, 'proposed');
  assert.match(s.notes.join(' '), /last claimed by b1, expired/);
});

test('a live PR is observed from GitHub, never taken from the record', () => {
  // work.pr is self-declared and any agent can write a work entry for a task it does not hold.
  const r = rec({ entries: [work('w1', 'abc1234')] });
  const s = W.stateOf(r, thread, { headSha: 'abc1234' }, no);
  assert.strictEqual(s.column, 'in-pr');
  assert.strictEqual(s.how['in-pr'], 'observed');
});

test('a work entry with no PR on GitHub is reported, not believed', () => {
  const s = W.stateOf(rec({ entries: [work('w1', 'abc1234')] }), thread, null, no);
  assert.strictEqual(s.column, 'proposed');
  assert.match(s.notes.join(' '), /claims a PR, but none was found/);
});

test('review is judged against the commit the PR is actually on', () => {
  const r = rec({ entries: [work('w1', 'abc1234')] });
  const seen = [];
  const spy = (entries, q) => { seen.push(q); return yes(); };
  const s = W.stateOf(r, thread, { headSha: 'def5678' }, spy);
  assert.deepStrictEqual(seen[0], { task: '42', commit: 'def5678' }, 'the live head, not the record');
  assert.strictEqual(s.column, 'reviewed');
  assert.strictEqual(s.how.reviewed, 'declared', 'vendor independence rests on what was declared');
});

test('a card drops back when a new commit lands that nothing covers', () => {
  const r = rec({ entries: [work('w1', 'abc1234')] });
  const s = W.stateOf(r, thread, { headSha: 'newhead' }, no);
  assert.strictEqual(s.column, 'in-pr', 'not reviewed: the review was for an older state');
  assert.strictEqual(s.stale, true);
  assert.match(s.notes.join(' '), /no work entry names the commit this PR is on/);
});

test('a verified sign-off on this commit is proved, and is the only chip that is', () => {
  const w = work('w1', 'abc1234');
  const r = rec({ entries: [w], verified: { ok: true, signoffs: [
    { status: 'verified', target: 'w1', decision: 'approve', signer: 'tapas' }] } });
  const s = W.stateOf(r, thread, { headSha: 'abc1234' }, yes);
  assert.strictEqual(s.column, 'signed-off');
  assert.strictEqual(s.how['signed-off'], 'proved');
});

test('a rejection is a sign-off too, and must not read as approval', () => {
  const w = work('w1', 'abc1234');
  const r = rec({ entries: [w], verified: { ok: true, signoffs: [
    { status: 'verified', target: 'w1', decision: 'reject', signer: 'tapas' }] } });
  const s = W.stateOf(r, thread, { headSha: 'abc1234' }, yes);
  assert.notStrictEqual(s.column, 'signed-off');
  assert.match(s.notes.join(' '), /an owner rejected this/);
});

test('a sign-off on an older commit does not cover this one', () => {
  const r = rec({ entries: [work('w1', 'abc1234')], verified: { ok: true, signoffs: [
    { status: 'verified', target: 'other', decision: 'approve', signer: 'tapas' }] } });
  const s = W.stateOf(r, thread, { headSha: 'abc1234' }, yes);
  assert.strictEqual(s.column, 'reviewed');
  assert.match(s.notes.join(' '), /sign-offs on record are for a different commit/);
});

test('an unverified sign-off is not counted at all', () => {
  const r = rec({ entries: [work('w1', 'abc1234')], verified: { ok: true, signoffs: [
    { status: 'unknown-key', target: 'w1', decision: 'approve', signer: 'stranger' }] } });
  assert.strictEqual(W.stateOf(r, thread, { headSha: 'abc1234' }, yes).column, 'reviewed');
});

test('merged wins, and these are not a pipeline: it can arrive straight from claimed', () => {
  const r = rec({ claims: [claim('builder', 'active')] });
  const s = W.stateOf(r, thread, { headSha: 'abc1234', merged: true }, no);
  assert.strictEqual(s.column, 'merged');
  assert.strictEqual(s.how.merged, 'observed');
});

test('summarise counts every column, including the empty ones', () => {
  const cards = [{ column: 'merged' }, { column: 'in-pr' }, { column: 'in-pr' }];
  const out = W.summarise(cards);
  assert.strictEqual(out['in-pr'], 2);
  assert.strictEqual(out.merged, 1);
  assert.strictEqual(out.proposed, 0);
  assert.deepStrictEqual(Object.keys(out), W.COLUMNS);
});
