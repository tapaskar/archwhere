'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const W = require('../lib/where');
const C = require('../lib/collide');

const arch = W.loadArch(path.join(__dirname, '..', 'examples', 'meridian'));

/**
 * A fake git. `table` maps "a|b" to the conflicted paths of that merge; `changed` maps a ref to
 * the files it touches since base, answering `git diff --name-only base...ref`.
 */
function fakeGit(table, changed = {}) {
  return (cmd, args) => {
    if (args[0] === 'diff') {
      const ref = String(args[args.length - 1]).split('...')[1];
      return (changed[ref] || []).join('\n') + '\n';
    }
    const [a, b] = args.slice(-2);
    const hit = table[a + '|' + b] ?? table[b + '|' + a];
    if (hit === undefined || hit === null) return 'treeid\n';           // clean
    const err = new Error('conflict');
    err.status = 1;
    err.stdout = 'treeid\n' + hit.join('\n') + '\n\nCONFLICT (content): …\n';
    throw err;
  };
}

test('a clean merge reports no files', () => {
  const r = C.mergeTree('.', 'a', 'b', fakeGit({}));
  assert.deepStrictEqual(r, { clean: true, files: [] });
});

test('merge-tree exiting 1 is an answer, not a failure', () => {
  const r = C.mergeTree('.', 'a', 'b', fakeGit({ 'a|b': ['CHANGELOG.md', 'README.md'] }));
  assert.strictEqual(r.clean, false);
  assert.deepStrictEqual(r.files, ['CHANGELOG.md', 'README.md']);
});

test('the path list stops at the blank line, so git messages are not read as files', () => {
  const run = () => { const e = new Error('c'); e.status = 1;
    e.stdout = 'treeid\nlib/a.js\n\nAuto-merging lib/a.js\nCONFLICT (content): Merge conflict in lib/a.js\n';
    throw e; };
  assert.deepStrictEqual(C.mergeTree('.', 'a', 'b', run).files, ['lib/a.js']);
});

test('a real git failure is not mistaken for a conflict', () => {
  const run = () => { const e = new Error('unknown revision'); e.status = 128; throw e; };
  assert.throws(() => C.mergeTree('.', 'a', 'b', run), /merge-tree failed/);
});

test('refs that could be read as options or traversals are refused', () => {
  for (const bad of ['--upload-pack=x', '-x', 'a..b', 'a b', 'a;rm -rf /', '']) {
    assert.throws(() => C.assertRef(bad), /unsafe ref/, bad);
  }
  assert.strictEqual(C.assertRef('feat/runtime-signals'), 'feat/runtime-signals');
});

test('a collision is reported in components, not only paths', () => {
  const run = fakeGit({ 'a|b': ['core/tickets/engine.js', 'features/search/index.js'] });
  const r = C.collide('.', arch, 'a', 'b', run);
  assert.strictEqual(r.clean, false);
  assert.deepStrictEqual(r.components, ['search', 'ticket-engine']);
});

test('files the model does not claim are reported separately, never silently dropped', () => {
  const run = fakeGit({ 'a|b': ['core/tickets/engine.js', 'NOTES.txt'] });
  const r = C.collide('.', arch, 'a', 'b', run);
  assert.deepStrictEqual(r.components, ['ticket-engine']);
  assert.deepStrictEqual(r.unmapped, ['NOTES.txt']);
});

test('the matrix covers every pair once and each ref against the base', () => {
  const m = C.matrix('.', arch, ['c', 'a', 'b'], { run: fakeGit({}) });
  assert.deepStrictEqual(m.refs, ['a', 'b', 'c']);                 // sorted, so it reads the same twice
  assert.deepStrictEqual(m.pairs.map(p => p.a + '|' + p.b), ['a|b', 'a|c', 'b|c']);
  assert.deepStrictEqual(m.vsBase.map(v => v.ref), ['a', 'b', 'c']);
});

test('duplicate refs are collapsed', () => {
  const m = C.matrix('.', arch, ['a', 'a', 'b'], { run: fakeGit({}) });
  assert.deepStrictEqual(m.refs, ['a', 'b']);
  assert.strictEqual(m.pairs.length, 1);
});

test('merge order puts the least entangled branch first', () => {
  // b overlaps with both others; a and c overlap with one each.
  const run = fakeGit({ 'a|b': ['x.md'], 'b|c': ['y.md'] },
    { a: ['x.md'], b: ['x.md', 'y.md'], c: ['y.md'] });
  const m = C.matrix('.', arch, ['a', 'b', 'c'], { run });
  assert.deepStrictEqual(m.order, [
    { ref: 'a', collides: 1 },
    { ref: 'c', collides: 1 },
    { ref: 'b', collides: 2 },
  ]);
});

test('with nothing colliding the order is stable and every count is zero', () => {
  const m = C.matrix('.', arch, ['b', 'a'], { run: fakeGit({}) });
  assert.deepStrictEqual(m.order, [{ ref: 'a', collides: 0 }, { ref: 'b', collides: 0 }]);
});

test('a branch behind base does not make every pair look entangled', () => {
  // `stale` conflicts with main. Its merge against `fresh` therefore conflicts too, but they
  // change different files, so the pair is marked confounded and the ordering ignores it.
  const run = fakeGit(
    { 'main|stale': ['README.md'], 'fresh|stale': ['README.md'] },
    { stale: ['lib/old.js'], fresh: ['lib/new.js'] });
  const m = C.matrix('.', arch, ['stale', 'fresh'], { run });

  assert.deepStrictEqual(m.stale, ['stale']);
  const p = m.pairs[0];
  assert.strictEqual(p.clean, false, 'the tips really do conflict');
  assert.deepStrictEqual(p.overlap, [], 'but they change nothing in common');
  assert.strictEqual(p.confounded, true);
  assert.deepStrictEqual(m.order.map(o => o.collides), [0, 0], 'staleness is not entanglement');
});

test('a genuine overlap is reported in components and counted', () => {
  const run = fakeGit({ 'a|b': ['core/tickets/engine.js'] },
    { a: ['core/tickets/engine.js'], b: ['core/tickets/engine.js', 'features/search/i.js'] });
  const m = C.matrix('.', arch, ['a', 'b'], { run });
  const p = m.pairs[0];
  assert.deepStrictEqual(p.overlap, ['core/tickets/engine.js']);
  assert.deepStrictEqual(p.overlapComponents, ['ticket-engine']);
  assert.strictEqual(p.confounded, false);
  assert.deepStrictEqual(m.order.map(o => o.collides), [1, 1]);
});
