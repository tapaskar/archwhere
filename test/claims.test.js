'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const R = require('../lib/record');
const C = require('../lib/claims');
const V = require('../lib/review');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'archwhere-claims-'));
const agent = (name, vendor = 'anthropic', model = 'claude-x') => ({ author: 'dana', agent: name, model, vendor });
const conflict = e => e.code === 'conflict';

test('a role on a task has one holder', () => {
  const d = tmp();
  const { claim: c } = C.claim(d, agent('b1'), { task: 'T-1', role: 'builder' });
  assert.strictEqual(c.status, 'active');
  assert.throws(() => C.claim(d, agent('b2'), { task: 'T-1', role: 'builder' }), conflict);
  assert.strictEqual(C.claim(d, agent('t1'), { task: 'T-1', role: 'tester' }).claim.role, 'tester');
  assert.strictEqual(C.claim(d, agent('r1'), { task: 'T-1', role: 'reviewer' }).claim.role, 'reviewer');
  assert.strictEqual(C.claim(d, agent('b2'), { task: 'T-2', role: 'builder' }).claim.task, 'T-2');
});

test('re-claiming what you hold returns the same claim and writes nothing', () => {
  const d = tmp();
  const a = C.claim(d, agent('b1'), { task: 'T-1', role: 'builder', branch: 'feat/x' });
  const n = R.load(d).entries.length;
  const b = C.claim(d, agent('b1'), { task: 'T-1', role: 'builder', branch: 'feat/x' });
  assert.strictEqual(b.already_held, true);
  assert.strictEqual(b.claim.claim_id, a.claim.claim_id);
  assert.strictEqual(R.load(d).entries.length, n);
});

test('one writer per branch, across tasks; a reviewer does not hold it', () => {
  const d = tmp();
  C.claim(d, agent('b1'), { task: 'T-1', role: 'builder', branch: 'feat/x' });
  assert.throws(() => C.claim(d, agent('b2'), { task: 'T-2', role: 'builder', branch: 'feat/x' }), /already has a writer/);
  assert.throws(() => C.claim(d, agent('t1'), { task: 'T-1', role: 'tester', branch: 'feat/x' }), /already has a writer/);
  C.claim(d, agent('r1', 'openai', 'gpt-x'), { task: 'T-1', role: 'reviewer', branch: 'feat/x' });
  const es = R.load(d).entries;
  assert.strictEqual(C.checkBranchWriter(es, { branch: 'feat/x', agent: 'b1' }).ok, true);
  assert.strictEqual(C.checkBranchWriter(es, { branch: 'feat/x', agent: 'r1' }).ok, false);
  assert.strictEqual(C.checkBranchWriter(es, { branch: 'feat/y', agent: 'r1' }).ok, true);
  assert.strictEqual(C.checkBranchWriter(es, { branch: 'feat/y', agent: 'r1', require: true }).ok, false);
});

test("the builder can't also review the task", () => {
  const d = tmp();
  C.claim(d, agent('b1'), { task: 'T-1', role: 'builder' });
  assert.throws(() => C.claim(d, agent('b1'), { task: 'T-1', role: 'reviewer' }), /can't also review/);
});

test('a stale claim expires, can be taken over, and its old holder is fenced out', () => {
  const d = tmp();
  const t0 = Date.now();
  const old = C.claim(d, agent('b1'), { task: 'T-1', role: 'builder', ttl: 10, branch: 'feat/x' }, { now: t0 }).claim;
  assert.throws(() => C.claim(d, agent('b2'), { task: 'T-1', role: 'builder', branch: 'feat/x' }, { now: t0 + 9 * 60000 }), conflict);
  const later = t0 + 11 * 60000;
  assert.strictEqual(C.foldClaims(R.load(d).entries, later).all[0].status, 'expired');
  const fresh = C.claim(d, agent('b2'), { task: 'T-1', role: 'builder', branch: 'feat/x' }, { now: later }).claim;
  assert.strictEqual(fresh.takes_over, old.claim_id);
  assert.throws(() => C.renew(d, agent('b1'), { claim_id: old.claim_id }, { now: later }), e => e.code === 'expired');
});

test('renew extends; only the holder may renew or release; ended stays ended', () => {
  const d = tmp();
  const t0 = Date.now();
  const c = C.claim(d, agent('b1'), { task: 'T-1', role: 'builder', ttl: 10 }, { now: t0 }).claim;
  assert.throws(() => C.renew(d, agent('b2'), { claim_id: c.claim_id }, { now: t0 }), e => e.code === 'not-holder');
  assert.throws(() => C.release(d, agent('b2'), { claim_id: c.claim_id }, { now: t0 }), e => e.code === 'not-holder');
  C.renew(d, agent('b1'), { claim_id: c.claim_id, ttl: 60 }, { now: t0 + 9 * 60000 });
  assert.strictEqual(C.foldClaims(R.load(d).entries, t0 + 30 * 60000).active.length, 1);
  const done = C.release(d, agent('b1'), { claim_id: c.claim_id, status: 'done', note: 'merged' }, { now: t0 + 31 * 60000 }).claim;
  assert.strictEqual(done.status, 'done');
  assert.throws(() => C.release(d, agent('b1'), { claim_id: c.claim_id }), e => e.code === 'expired');
  assert.throws(() => C.renew(d, agent('b1'), { claim_id: c.claim_id }), e => e.code === 'expired');
  assert.strictEqual(C.claim(d, agent('b2'), { task: 'T-1', role: 'builder' }).claim.agent, 'b2');
  assert.throws(() => C.renew(d, agent('b1'), { claim_id: 'c-none' }), e => e.code === 'not-found');
});

test('bad claim input is refused', () => {
  const d = tmp();
  assert.throws(() => C.claim(d, agent('a'), { task: 'T-1', role: 'owner' }), /role must be/);
  assert.throws(() => C.claim(d, agent('a'), { task: '../x', role: 'builder' }), /task ids/);
  assert.throws(() => C.claim(d, agent('a'), { task: 'T', role: 'builder', branch: '--force' }), /branch/);
  assert.throws(() => C.claim(d, agent('a'), { task: 'T', role: 'builder', branch: 'a..b' }), /branch/);
  assert.throws(() => C.claim(d, agent('a'), { task: 'T', role: 'builder', ttl: '99999h' }), /ttl/);
  assert.throws(() => C.claim(d, agent('a'), { task: 'T', role: 'builder', ttl: 'soon' }), /ttl/);
  assert.strictEqual(R.load(d).entries.length, 0);
});

test('ten processes race for one claim: exactly one wins, every time', async () => {
  const body = `
    const C = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'claims.js'))});
    const [dir, id] = process.argv.slice(1);
    try { const r = C.claim(dir, { author:'a', agent:'w'+id, model:'m', vendor:'v' }, { task:'T-1', role:'builder', branch:'feat/x' });
      console.log('won ' + r.claim.claim_id); }
    catch (e) { if (e.code !== 'conflict') throw e; console.log('lost'); }`;
  for (let round = 0; round < 3; round++) {
    const d = tmp();
    const outs = await Promise.all([...Array(10).keys()].map(i => new Promise((ok, no) => {
      const p = spawn(process.execPath, ['-e', body, d, String(i)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = '';
      p.stdout.on('data', c => { out += c; }); p.stderr.on('data', c => { err += c; });
      p.on('close', code => (code === 0 ? ok(out.trim()) : no(new Error(err))));
    })));
    assert.strictEqual(outs.filter(o => o.startsWith('won')).length, 1, outs.join(','));
    assert.strictEqual(outs.filter(o => o === 'lost').length, 9);
    assert.strictEqual(C.foldClaims(R.load(d).entries).active.length, 1);
    assert.strictEqual(R.verify(d).ok, true);
  }
});

test('claims made on separate clones collide on import: reported, not hidden', () => {
  const a = tmp(); const b = tmp();
  C.claim(a, agent('b1'), { task: 'T-1', role: 'builder', branch: 'feat/x' });
  C.claim(b, agent('b2'), { task: 'T-1', role: 'builder', branch: 'feat/x' });
  R.importBundle(a, R.exportBundle(b));
  const s = C.foldClaims(R.load(a).entries);
  assert.strictEqual(s.active.length, 2);
  assert.strictEqual(s.conflicts.length, 1);
  assert.strictEqual(s.conflicts[0].kind, 'task-role');
});

// ---------- the independent check ----------

const gpt = (name = 'r1') => agent(name, 'openai', 'gpt-x');
function reviewed(reviewer = gpt(), verdict = 'approve', extra = {}) {
  const d = tmp();
  C.claim(d, agent('b1'), { task: 'T-1', role: 'builder' });
  R.put(d, agent('b1'), { type: 'work', task: 'T-1', commit: 'abcdef1' });
  R.put(d, reviewer, { type: 'review', task: 'T-1', verdict, ...extra });
  return d;
}
const check = (d, q = { task: 'T-1' }) => V.independent(R.load(d).entries, q);

test('a different vendor and model approving passes, and says it is self-declared', () => {
  const r = check(reviewed());
  assert.strictEqual(r.ok, true);
  assert.match(r.note, /self-declared/);
  assert.strictEqual(r.authors[0].agent, 'b1');
});

test('same vendor fails even with a different model', () => {
  const r = check(reviewed(agent('r1', 'Anthropic', 'claude-other')));
  assert.strictEqual(r.ok, false);
  assert.ok(r.reviews[0].why.some(w => /same vendor/.test(w)));
});

test('same model fails even with a different declared vendor', () => {
  const r = check(reviewed(agent('r1', 'groq', 'mystery-1')));
  assert.strictEqual(r.ok, true);
  const d = tmp();
  R.put(d, agent('b1', 'acme', 'mystery-1'), { type: 'work', task: 'T-1' });
  R.put(d, agent('r1', 'other', 'mystery-1'), { type: 'review', task: 'T-1', verdict: 'approve' });
  assert.ok(check(d).reviews[0].why.some(w => /same model/.test(w)));
  assert.strictEqual(check(d).ok, false);
});

test('a hosted copy does not count as another vendor: the model name gives it away', () => {
  const r = check(reviewed(agent('r1', 'aws', 'us.anthropic.claude-other-v1:0')));
  assert.strictEqual(r.ok, false);
  assert.ok(r.reviews[0].why.some(w => /same vendor/.test(w)));
  assert.ok(r.reviews[0].why.some(w => /points to anthropic/.test(w)));
});

test('no usable declaration, no pass', () => {
  assert.strictEqual(check(reviewed(agent('r1', 'unknown', 'unknown'))).ok, false);
});

test('needs an approval, a review, and an author', () => {
  assert.strictEqual(check(reviewed(gpt(), 'changes')).ok, false);
  const none = tmp();
  R.put(none, agent('b1'), { type: 'work', task: 'T-1' });
  assert.ok(check(none).reasons.includes('no review recorded'));
  const noAuthor = tmp();
  R.put(noAuthor, gpt(), { type: 'review', task: 'T-1', verdict: 'approve' });
  assert.strictEqual(check(noAuthor).ok, false);
  assert.throws(() => V.independent([], {}), /--task or --target/);
});

test('work after the review makes it stale', () => {
  const d = reviewed();
  assert.strictEqual(check(d).ok, true);
  R.put(d, agent('b1'), { type: 'work', task: 'T-1', commit: 'abcdef2' });
  const r = check(d);
  assert.strictEqual(r.ok, false);
  assert.ok(r.reviews[0].why.some(w => /stale/.test(w)));
});

test('a required commit must be the one reviewed', () => {
  const d = reviewed(gpt(), 'approve', { commit: 'abcdef1' });
  assert.strictEqual(check(d, { task: 'T-1', commit: 'abcdef1' }).ok, true);
  assert.strictEqual(check(d, { task: 'T-1', commit: 'abcdef9' }).ok, false);
});

test('reviewing one entry compares with that entry\'s author', () => {
  const d = tmp();
  const spec = R.putSpec(d, agent('b1'), { name: 's', text: 'x' }).entry;
  R.put(d, agent('b2'), { type: 'review', target: spec.hash, verdict: 'approve' });
  assert.strictEqual(check(d, { target: spec.hash }).ok, false);
  R.put(d, gpt(), { type: 'review', target: spec.hash, verdict: 'approve' });
  assert.strictEqual(check(d, { target: spec.hash }).ok, true);
});

test('a human can review an agent, but not their own work, and the note warns it is a claim', () => {
  const r = check(reviewed({ actor: 'human', author: 'dana' }));
  assert.strictEqual(r.ok, true);
  assert.match(r.note, /unverified unless an owner sign-off/);
  const d = tmp();
  const own = R.put(d, { actor: 'human', author: 'dana' }, { type: 'decision', title: 'x' });
  R.put(d, { actor: 'human', author: 'dana' }, { type: 'review', target: own.hash, verdict: 'approve' });
  assert.strictEqual(check(d, { target: own.hash }).ok, false);
});

// Both found by Kiro reviewing #17 through the bridge, and reproduced before fixing.
test('a claim whose expiry cannot be read is not a live claim', () => {
  // Date.parse('not-a-date') is NaN and `NaN <= now` is false, so this claim stayed active
  // for ever. An unreadable expiry is not a licence to hold a task indefinitely.
  const e = [{ type: 'claim', hash: 'h1', task: 'T1', role: 'builder', agent: 'a1',
               claim_id: 'c1', expires_at: 'not-a-date', ts: '2026-11-06T00:00:00Z' }];
  const f = C.foldClaims(e, Date.parse('2027-01-01T00:00:00Z'));
  assert.deepStrictEqual(f.active, []);
  assert.strictEqual(f.all[0].status, 'expired');
});

test('a readable expiry still governs normally', () => {
  const e = [{ type: 'claim', hash: 'h1', task: 'T1', role: 'builder', agent: 'a1',
               claim_id: 'c1', expires_at: '2026-11-06T01:00:00Z', ts: '2026-11-06T00:00:00Z' }];
  assert.strictEqual(C.foldClaims(e, Date.parse('2026-11-06T00:30:00Z')).active.length, 1);
  assert.strictEqual(C.foldClaims(e, Date.parse('2026-11-06T02:00:00Z')).active.length, 0);
});

test('a reviewer who approves then asks for changes has not approved', () => {
  // Only the newest verdict per reviewer counts. Otherwise a stale approve outlives the
  // objection that replaced it, and `record independent` certifies work that was rejected.
  const mk = (hash, verdict) => ({ type: 'review', hash, task: 'T-9', verdict, commit: 'abc1234',
    author: 'rev', agent: 'r1', model: 'gpt-5', vendor: 'openai', ts: '2026-11-06T00:00:0' + hash.slice(-1) + 'Z' });
  const entries = [
    { type: 'work', hash: 'w1', task: 'T-9', commit: 'abc1234',
      author: 'builder', agent: 'b1', model: 'claude-opus-5', vendor: 'anthropic', ts: '2026-11-06T00:00:00Z' },
    mk('r1', 'approve'),
    mk('r2', 'changes'),
  ];
  const out = V.independent(entries, { task: 'T-9', commit: 'abc1234' });
  assert.strictEqual(out.ok, false, 'a superseded approve must not certify the work');
  const stale = out.reviews.find(r => r.hash === 'r1');
  assert.ok(stale.why.some(w => /superseded/.test(w)), 'says why it no longer counts');
});

// Three gaps Kiro raised on #17, each reproduced before being closed.
test('only the holder can move their own claim', () => {
  // The write path checks this, but the fold is what a reader trusts — and an imported segment
  // can carry an update nobody authorised.
  const base = { task: 'T1', role: 'builder', claim_id: 'c1', expires_at: '2026-11-07T00:00:00Z' };
  const entries = [
    { type: 'claim', hash: 'h1', ts: '2026-11-06T00:00:00Z', ...base,
      author: 'dana', agent: 'a1', model: 'gpt-5', vendor: 'openai' },
    { type: 'claim-update', hash: 'h2', ts: '2026-11-06T00:10:00Z', claim_id: 'c1', status: 'released',
      author: 'mallory', agent: 'a2', model: 'claude-opus-5', vendor: 'anthropic' },
  ];
  const f = C.foldClaims(entries, Date.parse('2026-11-06T00:20:00Z'));
  assert.strictEqual(f.all[0].status, 'active', 'a stranger cannot release it');
  assert.deepStrictEqual(f.all[0].rejected, [{ entry: 'h2', why: 'not the holder' }]);
});

test('the holder can still release and renew', () => {
  const who = { author: 'dana', agent: 'a1', model: 'gpt-5', vendor: 'openai' };
  const entries = [
    { type: 'claim', hash: 'h1', ts: '2026-11-06T00:00:00Z', task: 'T1', role: 'builder',
      claim_id: 'c1', expires_at: '2026-11-06T01:00:00Z', ...who },
    { type: 'claim-update', hash: 'h2', ts: '2026-11-06T00:10:00Z', claim_id: 'c1', status: 'released', ...who },
  ];
  assert.strictEqual(C.foldClaims(entries, Date.parse('2026-11-06T00:20:00Z')).all[0].status, 'released');
});

test('a renewal cannot reach further than one ttl past when it was written', () => {
  // Otherwise an entry grants itself a claim lasting years, and no reader would notice.
  const who = { author: 'dana', agent: 'a1', model: 'gpt-5', vendor: 'openai' };
  const entries = [
    { type: 'claim', hash: 'h1', ts: '2026-11-06T00:00:00Z', task: 'T1', role: 'builder',
      claim_id: 'c1', expires_at: '2026-11-06T01:00:00Z', ...who },
    { type: 'claim-update', hash: 'h2', ts: '2026-11-06T00:10:00Z', claim_id: 'c1',
      expires_at: '2027-11-06T00:00:00Z', ...who },
  ];
  const f = C.foldClaims(entries, Date.parse('2026-11-06T02:00:00Z'));
  assert.strictEqual(f.all[0].status, 'expired', 'the year-long renewal was refused');
  assert.deepStrictEqual(f.all[0].rejected, [{ entry: 'h2', why: 'renewal beyond the maximum ttl' }]);
});

test('a renewal within the cap is honoured', () => {
  const who = { author: 'dana', agent: 'a1', model: 'gpt-5', vendor: 'openai' };
  const entries = [
    { type: 'claim', hash: 'h1', ts: '2026-11-06T00:00:00Z', task: 'T1', role: 'builder',
      claim_id: 'c1', expires_at: '2026-11-06T01:00:00Z', ...who },
    { type: 'claim-update', hash: 'h2', ts: '2026-11-06T00:10:00Z', claim_id: 'c1',
      expires_at: '2026-11-06T03:00:00Z', ...who },
  ];
  const f = C.foldClaims(entries, Date.parse('2026-11-06T02:00:00Z'));
  assert.strictEqual(f.all[0].status, 'active');
  assert.ok(!f.all[0].rejected);
});
