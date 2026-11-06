'use strict';
// archwhere declares that a pull request adding a module extends a component's globs in the same
// pull request, and that the map going stale fails the build. That rule was not enforced here.
//
// The `selfmap` CI job runs `archwhere map`, which comments on a pull request with the components
// a diff touches. It never ran `archwhere check`, so archwhere's own model could go stale with a
// green tick — and it did: `.gitattributes` landed unmapped and only a hand-run of `check` caught
// it. A test is the right home rather than another CI step: it runs locally, on pushes to main,
// and on every pull request, which a pull-request-only job does not.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');
const W = require('../lib/where');

const ROOT = path.join(__dirname, '..');

/** Tracked files, or null outside a git checkout (a published tarball, say) — then we skip. */
function tracked() {
  try {
    return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean);
  } catch (_) { return null; }
}

test('archwhere’s own map claims every file it tracks', (t) => {
  const files = tracked();
  if (!files) return t.skip('not a git checkout');

  const arch = W.loadArch(ROOT);
  const { unmapped } = W.mapFiles(arch, files);

  assert.deepStrictEqual(unmapped, [],
    'unmapped files — extend a component’s paths in this same PR, or run `archwhere check --fix`:\n  '
    + unmapped.join('\n  '));
});

test('every declared component owns at least one tracked file', (t) => {
  const files = tracked();
  if (!files) return t.skip('not a git checkout');

  const arch = W.loadArch(ROOT);
  const { byComponent } = W.mapFiles(arch, files);
  const empty = Object.keys(arch.components).filter(id => !byComponent.has(id));

  // A component matching nothing is either a typo in its globs or a component that outlived the
  // code it described. Both are the map drifting from the repository, which is what this guards.
  assert.deepStrictEqual(empty, [], 'components matching no tracked file: ' + empty.join(', '));
});
