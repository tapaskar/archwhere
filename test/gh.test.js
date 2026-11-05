'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const G = require('../lib/gh');
const L = require('../lib/rail');

test('githubToken prefers GITHUB_TOKEN', () => {
  assert.strictEqual(G.githubToken({ GITHUB_TOKEN: 'tok' }), 'tok');
});

test('apiBase defaults and strips a trailing slash', () => {
  assert.strictEqual(G.apiBase({}), 'https://api.github.com');
  assert.strictEqual(G.apiBase({ GITHUB_API: 'https://ghe.acme.com/api/v3/' }), 'https://ghe.acme.com/api/v3');
});

test('originRepo reads the origin remote', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-origin-'));
  try {
    const q = { cwd: dir, stdio: 'ignore' };
    execFileSync('git', ['init', '-q'], q);
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/meridian.git'], q);
    assert.deepStrictEqual(G.originRepo(dir, L.parseRepo), { owner: 'acme', repo: 'meridian' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// `npx archwhere mission` outside a clone used to die with a raw child_process stack trace.
test('originRepo explains itself instead of throwing a stack trace', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-norepo-'));
  try {
    assert.throws(() => G.originRepo(dir, L.parseRepo), err => {
      assert.match(err.message, /no git "origin" remote/);
      assert.match(err.message, /--repo owner\/name/);        // says how to proceed
      assert.doesNotMatch(err.message, /execFileSync|ENOENT|status 128/);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('originRepo reports a remote it cannot parse', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-gitlab-'));
  try {
    const q = { cwd: dir, stdio: 'ignore' };
    execFileSync('git', ['init', '-q'], q);
    execFileSync('git', ['remote', 'add', 'origin', 'https://gitlab.com/acme/meridian.git'], q);
    assert.throws(() => G.originRepo(dir, L.parseRepo), /cannot parse GitHub remote/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
