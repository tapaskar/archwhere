'use strict';
// archwhere collisions: which branches in flight will fight each other.
//
// GitHub computes a pull request against its base and nothing else. When several agents work at
// once the expensive conflict is pull request against pull request, and nobody reports it until
// the second merge — by which time one of them has to be rebased by hand. This answers it before
// either lands, and in components rather than paths: "both touch mission" is worth more to a
// reviewer than five file names.
//
// Nothing here calls GitHub. `git merge-tree` does the merge in memory, writes nothing, and needs
// no working tree, so the matrix is cheap enough to compute on every page load.

const { execFileSync } = require('child_process');
const { mapFiles } = require('./where');

/** Reject anything that could be read as an option; these strings reach git. */
const SAFE_REF = /^[A-Za-z0-9._\/-]{1,200}$/;

function assertRef(r) {
  if (!SAFE_REF.test(String(r || '')) || String(r).startsWith('-') || String(r).includes('..')) {
    throw new Error('unsafe ref: ' + r);
  }
  return String(r);
}

/**
 * Merge two refs in memory.
 * merge-tree prints the tree id, then the conflicted paths, then a blank line and its messages;
 * it exits 1 when they conflict, which is an answer and not a failure.
 */
function mergeTree(root, a, b, run = execFileSync) {
  assertRef(a); assertRef(b);
  let out, code = 0;
  try {
    out = run('git', ['merge-tree', '--write-tree', '--name-only', a, b],
      { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    // status 1 is "they conflict". Anything else — a bad ref, no git — is a real error.
    if (e && e.status === 1 && typeof e.stdout === 'string') { out = e.stdout; code = 1; }
    else throw new Error('merge-tree failed for ' + a + ' and ' + b + ': ' + (e && e.message));
  }
  if (code === 0) return { clean: true, files: [] };

  const lines = String(out).split('\n');
  const files = [];
  for (let i = 1; i < lines.length; i++) {      // line 0 is the tree id
    const l = lines[i];
    if (l === '') break;                        // the blank line ends the path list
    files.push(l);
  }
  return { clean: false, files };
}

/** Files a ref changes relative to base (three-dot: only the ref's own work). */
function changedSince(root, base, ref, run = execFileSync) {
  assertRef(base); assertRef(ref);
  const out = run('git', ['diff', '--name-only', base + '...' + ref],
    { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return String(out).split('\n').filter(Boolean);
}

/** One pair, with the conflict expressed in components as well as paths. */
function collide(root, arch, a, b, run) {
  const { clean, files } = mergeTree(root, a, b, run);
  if (clean) return { a, b, clean: true, files: [], components: [], unmapped: [] };
  const { byComponent, unmapped } = mapFiles(arch, files);
  return {
    a, b, clean: false, files,
    components: [...byComponent.keys()].sort(),
    unmapped,
  };
}

/**
 * Every pair of refs, plus each ref against the base.
 * `refs` are branch names; order of a pair is stable (sorted) so the matrix reads the same twice.
 */
function matrix(root, arch, refs, { base = 'main', run } = {}) {
  const list = [...new Set(refs.map(assertRef))].sort();
  const vsBase = list.map(r => ({ ref: r, ...collide(root, arch, base, r, run) }));
  const staleRefs = new Set(vsBase.filter(v => !v.clean).map(v => v.ref));

  // What each branch changes on its own. A branch that is behind base conflicts with every branch
  // that is current, which says nothing about the two of them — so overlap, which is immune to
  // that, is reported beside the merge result and the pair is marked confounded.
  const changed = {};
  for (const r of list) {
    try { changed[r] = changedSince(root, base, r, run); } catch (_) { changed[r] = []; }
  }

  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const p = collide(root, arch, a, b, run);
      const both = changed[a].filter(f => changed[b].includes(f));
      p.overlap = both;
      p.overlapComponents = both.length ? [...mapFiles(arch, both).byComponent.keys()].sort() : [];
      p.confounded = staleRefs.has(a) || staleRefs.has(b);
      pairs.push(p);
    }
  }
  return { base, refs: list, vsBase, stale: [...staleRefs].sort(), pairs, order: mergeOrder(list, pairs) };
}

/**
 * A merge order that minimises rebasing.
 * Every merge forces whatever it collides with to be rebased, so land the least entangled first
 * and the cascade is smallest. Ties break on name, so the answer is stable rather than arbitrary.
 */
function mergeOrder(refs, pairs) {
  const degree = Object.fromEntries(refs.map(r => [r, 0]));
  for (const p of pairs) {
    // Count genuine entanglement: files both branches changed. A conflict that only exists
    // because one branch is stale would otherwise make every ordering look equally bad.
    const real = p.overlap ? p.overlap.length > 0 : !p.clean;
    if (!real) continue;
    degree[p.a] = (degree[p.a] || 0) + 1;
    degree[p.b] = (degree[p.b] || 0) + 1;
  }
  return [...refs].sort((x, y) => degree[x] - degree[y] || x.localeCompare(y))
    .map(ref => ({ ref, collides: degree[ref] }));
}

module.exports = { matrix, collide, mergeTree, mergeOrder, changedSince, assertRef };
