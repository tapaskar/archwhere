'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawnSync } = require('child_process');
const R = require('../lib/record');

const BIN = path.join(__dirname, '..', 'bin', 'archwhere.js');
const ID = ['--author', 'dana', '--agent', 'b1', '--model', 'claude-x', '--vendor', 'anthropic'];
const OTHER = ['--author', 'dana', '--agent', 'r1', '--model', 'gpt-x', '--vendor', 'openai'];

function repo() {
  const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archwhere-cli-')));
  const g = (...a) => execFileSync('git', ['-C', r, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main'); g('commit', '-q', '--allow-empty', '-m', 'x');
  return r;
}
const run = (r, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: r, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: r, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' } });
const segFile = r => { const d = path.join(r, '.archwhere', 'record'); return path.join(d, fs.readdirSync(d).find(n => /^log-/.test(n))); };

test('help, and a clear error for an unknown command', () => {
  const r = repo();
  assert.match(run(r, 'record', 'help').stdout, /record verify/);
  assert.match(run(r, 'task', 'help').stdout, /task claim/);
  assert.match(run(r, 'help').stdout, /archwhere mcp/);
  const bad = run(r, 'record', 'nope');
  assert.strictEqual(bad.status, 2);
  assert.match(bad.stderr, /unknown record command/);
});

test('without an identity, nothing is written and the message says what is missing', () => {
  const r = repo();
  const res = run(r, 'record', 'put', 'finding', '--title', 'x');
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /agent, model, vendor|author/);
  assert.ok(!fs.existsSync(path.join(r, '.archwhere', 'record', '.local-segment')));
});

test('spec round trip: --raw returns the exact bytes; binary files are refused', () => {
  const r = repo();
  const f = path.join(r, 'spec.md');
  const bytes = Buffer.from('word for word\r\n\t"✓"  \n\n', 'utf8');
  fs.writeFileSync(f, bytes);
  assert.strictEqual(run(r, 'record', 'spec', 'put', 'auth', '--file', f, ...ID).status, 0);
  const out = spawnSync(process.execPath, [BIN, 'record', 'spec', 'get', 'auth', '--raw'], { cwd: r });
  assert.ok(out.stdout.equals(bytes));
  assert.match(run(r, 'record', 'spec', 'list').stdout, /auth\s+v1/);
  fs.writeFileSync(f, Buffer.from([0xff, 0xfe, 0x00]));
  const bin = run(r, 'record', 'spec', 'put', 'bin', '--file', f, ...ID);
  assert.strictEqual(bin.status, 1);
  assert.match(bin.stderr, /not valid UTF-8/);
});

test('verify exits 1 on tampering, and says plainly what it does not cover', () => {
  const r = repo();
  run(r, 'record', 'put', 'finding', '--title', 'original', ...ID);
  const good = run(r, 'record', 'verify');
  assert.strictEqual(good.status, 0);
  assert.match(good.stdout, /not anchored/);
  assert.strictEqual(run(r, 'record', 'verify', '--strict').status, 1, '--strict wants an anchor');
  fs.writeFileSync(segFile(r), fs.readFileSync(segFile(r), 'utf8').replace('original', 'changed'));
  const bad = run(r, 'record', 'verify');
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stdout, /edited/);
  assert.strictEqual(JSON.parse(run(r, 'record', 'verify', '--json').stdout).ok, false);
});

test('anchoring in a git tag catches a later full rewrite', () => {
  const r = repo();
  run(r, 'record', 'put', 'finding', '--title', 'one', ...ID);
  const anchored = run(r, 'record', 'anchor', '--tag');
  assert.strictEqual(anchored.status, 0, anchored.stderr);
  const tag = execFileSync('git', ['-C', r, 'tag', '-l', '-n99'], { encoding: 'utf8' });
  assert.match(tag, /archwhere-record-anchor v1/);
  assert.doesNotMatch(tag, /"one"|\bone\b/, 'only hashes leave the record');
  const ok = run(r, 'record', 'verify', '--strict');
  assert.strictEqual(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /anchors checked: 1/);
  // Rewrite the whole chain, correct hashes and witness included.
  const e = JSON.parse(fs.readFileSync(segFile(r), 'utf8'));
  e.title = 'rewritten'; e.hash = R.hashOf(e);
  fs.writeFileSync(segFile(r), R.canonical(e) + '\n');
  fs.writeFileSync(path.join(path.dirname(segFile(r)), '.local-head.json'), JSON.stringify({ segments: { [e.seg]: { seq: 0, hash: e.hash } } }));
  const caught = run(r, 'record', 'verify');
  assert.strictEqual(caught.status, 1);
  assert.match(caught.stdout, /anchor-mismatch/);
  assert.match(run(r, 'record', 'anchor', '--tag').stderr, /does not verify/);
});

test('`record anchor` with no target only prints; an empty record has nothing to anchor', () => {
  const r = repo();
  assert.match(run(r, 'record', 'anchor').stderr, /empty/);
  run(r, 'record', 'put', 'finding', '--title', 'one', ...ID);
  assert.match(run(r, 'record', 'anchor').stdout, /^archwhere-record-anchor v1 digest=/);
  assert.strictEqual(execFileSync('git', ['-C', r, 'tag'], { encoding: 'utf8' }), '');
});

test('anchors in a GitHub comment count only from repo members', async () => {
  const r = repo();
  execFileSync('git', ['-C', r, 'remote', 'add', 'origin', 'https://github.com/acme/meridian.git']);
  run(r, 'record', 'put', 'finding', '--title', 'one', ...ID);
  const text = run(r, 'record', 'anchor').stdout.trim();
  const comments = [{ author_association: 'NONE', user: { login: 'stranger' }, body: text.replace(/:0:[0-9a-f]{4}/, ':0:0000') }];
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(comments)); });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}`;
  const verify = () => new Promise(ok => {
    const { spawn } = require('child_process');
    const p = spawn(process.execPath, [BIN, 'record', 'verify', '--issue', '5'], { cwd: r, env: { PATH: process.env.PATH, HOME: r, GITHUB_API: url, GITHUB_TOKEN: 'x' } });
    let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
    p.on('close', code => ok({ code, out }));
  });
  assert.match((await verify()).out, /anchors checked: 0/);
  comments.push({ author_association: 'OWNER', user: { login: 'dana' }, body: `anchoring: ${text}` });
  const res = await verify();
  assert.strictEqual(res.code, 0, res.out);
  assert.match(res.out, /anchors checked: 1/);
  server.close();
});

test('independent is a CI-usable check: exit 0 or 1', () => {
  const r = repo();
  run(r, 'task', 'claim', 'T-1', '--role', 'builder', ...ID);
  assert.strictEqual(run(r, 'record', 'independent', '--task', 'T-1').status, 1);
  run(r, 'record', 'put', 'review', '--task', 'T-1', '--verdict', 'approve', ...ID.slice(0, 2), '--agent', 'b2', '--model', 'claude-y', '--vendor', 'anthropic');
  const same = run(r, 'record', 'independent', '--task', 'T-1');
  assert.strictEqual(same.status, 1);
  assert.match(same.stdout, /same vendor/);
  run(r, 'record', 'put', 'review', '--task', 'T-1', '--verdict', 'approve', '--commit', 'abcdef1', ...OTHER);
  const yes = run(r, 'record', 'independent', '--task', 'T-1');
  assert.strictEqual(yes.status, 0, yes.stdout);
  assert.match(yes.stdout, /self-declared/);
  assert.strictEqual(run(r, 'record', 'independent', '--task', 'T-1', '--commit', 'abcdef2').status, 1);
});

test('task commands: claim, conflict, list, check, renew, release', () => {
  const r = repo();
  const c = JSON.parse(run(r, 'task', 'claim', 'T-1', '--role', 'builder', '--branch', 'feat/x', '--ttl', '10m', '--json', ...ID).stdout).claim;
  const lost = run(r, 'task', 'claim', 'T-1', '--role', 'builder', ...OTHER);
  assert.strictEqual(lost.status, 1);
  assert.match(lost.stderr, /is held by b1/);
  assert.match(run(r, 'task', 'list').stdout, /T-1\s+builder\s+active/);
  assert.strictEqual(run(r, 'task', 'check', '--branch', 'feat/x', '--agent', 'b1').status, 0);
  assert.strictEqual(run(r, 'task', 'check', '--branch', 'feat/x', '--agent', 'r1').status, 1);
  assert.strictEqual(run(r, 'task', 'check', '--branch', 'other', '--agent', 'r1', '--require').status, 1);
  assert.strictEqual(run(r, 'task', 'renew', c.claim_id, ...OTHER).status, 1);
  assert.match(run(r, 'task', 'renew', c.claim_id, '--ttl', '1h', ...ID).stdout, /renewed/);
  assert.match(run(r, 'task', 'release', c.claim_id, '--status', 'done', ...ID).stdout, /ended/);
  assert.match(run(r, 'task', 'list').stdout, /no claims/);
  assert.match(run(r, 'task', 'list', '--all').stdout, /done/);
});

test('hostile text is cleaned for the terminal but kept in the record', () => {
  const r = repo();
  const evil = '\u001b[2Jwiped\u001b]0;title\u0007 \u202ereversed';
  const res = spawnSync(process.execPath, [BIN, 'record', 'put', 'finding', '--title', 'plain', '--body', evil, ...ID], { cwd: r, encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  const hash = res.stdout.trim().split(' ').pop();
  const shown = run(r, 'record', 'get', hash).stdout;
  assert.strictEqual(shown.includes('\u001b'), false);
  assert.strictEqual(shown.includes('\u202e'), false);
  assert.match(shown, /wiped/);
  assert.strictEqual(JSON.parse(run(r, 'record', 'get', hash, '--json').stdout).body, evil);
  const search = run(r, 'record', 'search', 'plain');
  assert.match(search.stdout, /1 of 1/);
});

test('export to a file, import elsewhere, verify there', () => {
  const r = repo(); const other = repo();
  run(r, 'record', 'put', 'finding', '--title', 'one', ...ID);
  const f = path.join(r, 'bundle.jsonl');
  assert.match(run(r, 'record', 'export', '--out', f).stdout, /sensitive/);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  assert.match(run(other, 'record', 'import', f).stdout, /added 1/);
  assert.strictEqual(run(other, 'record', 'verify').status, 0);
  assert.match(run(other, 'record', 'search', 'one').stdout, /1 of 1/);
  assert.strictEqual(run(other, 'record', 'import', path.join(other, 'missing')).status, 1);
  assert.match(run(other, 'record', 'init', '--commit').stdout, /WILL be committed/);
});

test('mission control\'s record view is read-only and copes with no record', () => {
  const r = repo();
  const { recordView } = require('../lib/mission');
  const empty = recordView(r);
  assert.deepStrictEqual([empty.ok, empty.count, empty.latest], [true, 0, []]);
  assert.ok(!fs.existsSync(path.join(r, '.archwhere')));
  run(r, 'record', 'put', 'finding', '--title', '<img src=x onerror=alert(1)>', ...ID);
  const view = recordView(r);
  assert.strictEqual(view.count, 1);
  assert.strictEqual(view.latest[0].made_by, 'agent');
  const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'mission.html'), 'utf8');
  const fn = html.slice(html.indexOf('async function showRecord'), html.indexOf('// ---- System flow lens'));
  assert.doesNotMatch(fn, /innerHTML/, 'record text goes in as textContent only');
});
