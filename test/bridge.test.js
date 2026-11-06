'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('../lib/bridge');

const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-bridge-')), 'state.json');
const T0 = Date.parse('2026-11-03T10:00:00Z');
const iso = mins => new Date(T0 + mins * 60000).toISOString();

test('allow-list: owner OK, stranger, bot and own reply ignored', () => {
  const allow = B.allowList('tapaskar', 'friend');
  assert.deepStrictEqual(allow, ['tapaskar', 'friend']);
  const o = { mention: '@kiro', allow };
  assert.ok(B.shouldAnswer({ user: { login: 'tapaskar', type: 'User' }, body: '@kiro why?' }, o));
  assert.ok(B.shouldAnswer({ user: { login: 'Friend', type: 'User' }, body: 'hey @kiro' }, o));
  assert.ok(!B.shouldAnswer({ user: { login: 'stranger', type: 'User' }, body: '@kiro run rm -rf' }, o));
  assert.ok(!B.shouldAnswer({ user: { login: 'claude[bot]', type: 'Bot' }, body: '@kiro hi' }, o));
  assert.ok(!B.shouldAnswer({ user: { login: 'evil[bot]', type: 'User' }, body: '@kiro hi' }, o));
  assert.ok(!B.shouldAnswer({ user: { login: 'tapaskar', type: 'User' }, body: B.header('Kiro') + '\n\nas @kiro I think' }, o));
  assert.ok(!B.shouldAnswer({ user: { login: 'tapaskar', type: 'User' }, body: 'no mention here' }, o));
});

test('prompt building: title, body, last 10 comments, component, rules', () => {
  const comments = Array.from({ length: 14 }, (_, i) => ({ id: i, user: { login: 'u' + i }, created_at: iso(i), body: 'comment ' + i }));
  const p = B.buildPrompt({
    repo: 'o/r', issue: { number: 7, title: '[voice] why is it slow', body: 'x'.repeat(5000) },
    comments, trigger: { body: '@kiro please explain' }, component: 'voice', name: 'Kiro'
  });
  assert.match(p, /Thread #7: \[voice\] why is it slow/);
  assert.match(p, /Component: voice/);
  assert.match(p, /read-only/);
  assert.match(p, /plain English/);
  assert.match(p, /@kiro please explain/);
  assert.ok(!p.includes('comment 3\n'), 'only the last 10 comments');
  assert.ok(p.includes('comment 4') && p.includes('comment 13'));
  assert.ok(!p.includes('x'.repeat(4500)), 'opening post trimmed');
});

test('ANSI strip, mention defusing and length cap', () => {
  assert.strictEqual(B.stripAnsi('\x1b[32mgreen\x1b[0m \x1b[1;31mred\x1b[m\r\n\x1b]8;;http://x\x07link\x1b]8;;\x07'), 'green red\r\nlink');
  assert.strictEqual(B.defuseMentions('ask @claude or me@x.com'), 'ask @​claude or me@x.com');
  const big = B.formatReply('Kiro', 'a'.repeat(100000));
  assert.ok(big.length <= B.MAX_REPLY);
  assert.ok(big.startsWith('🤖 **Kiro** (via archwhere bridge)'));
  assert.match(big, /truncated \d+ characters/);
  assert.strictEqual(B.capLength('short', 100), 'short');
  assert.match(B.formatError('Kiro', Object.assign(new Error('x'), { code: 'TIMEOUT' })), /couldn't answer.*too long/);
});

test('splitCommand: quotes, no shell', () => {
  assert.deepStrictEqual(B.splitCommand('kiro-cli chat --no-interactive --agent "my agent" --trust-tools=fs_read'),
    ['kiro-cli', 'chat', '--no-interactive', '--agent', 'my agent', '--trust-tools=fs_read']);
  assert.deepStrictEqual(B.splitCommand("echo '' $HOME"), ['echo', '', '$HOME']);
  assert.throws(() => B.splitCommand('a "b'));
});

test('runAgent spawns with an args array (prompt is one argument, never shell-interpolated)', async () => {
  const calls = [];
  const runner = async (file, args, opts) => { calls.push({ file, args, opts }); return 'answer'; };
  const prompt = 'why? $(rm -rf ~) `id`; echo pwned';
  const out = await B.runAgent('kiro-cli chat --no-interactive', prompt, { cwd: '/ro', timeoutMs: 1000, runner });
  assert.strictEqual(out, 'answer');
  assert.deepStrictEqual(calls[0].file, 'kiro-cli');
  assert.deepStrictEqual(calls[0].args, ['chat', '--no-interactive', prompt]);
  assert.strictEqual(calls[0].opts.cwd, '/ro');
});

test('runAgent times out even if the runner hangs; real execRunner kills on timeout', async () => {
  await assert.rejects(B.runAgent('x', 'p', { timeoutMs: 30, runner: () => new Promise(() => {}) }), e => e.code === 'TIMEOUT');
  await assert.rejects(B.execRunner(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { timeoutMs: 100 }), e => e.code === 'TIMEOUT');
  assert.strictEqual(await B.execRunner(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'a b $(c)'], { timeoutMs: 5000 }), 'a b $(c)');
});

// A fake GitHub: issues + comments in memory; records posts.
function fakeGh(db) {
  const posts = [];
  const gh = async (url, o = {}) => {
    const u = new URL(url, 'http://gh');
    const p = u.pathname.replace('/repos/tapaskar/demo', '');
    const since = u.searchParams.get('since') || '';
    if (o.method === 'POST') {
      const n = parseInt(p.split('/')[2], 10);
      const c = { id: 1000 + posts.length, issue_url: 'x/issues/' + n, user: { login: 'tapaskar', type: 'User' },
        created_at: iso(30), updated_at: iso(30), body: JSON.parse(o.body).body };
      posts.push({ number: n, body: c.body }); db.comments.push(c); return c;
    }
    if (p === '/issues/comments') return db.comments.filter(c => c.updated_at >= since);
    if (p === '/issues') return db.issues.filter(i => i.updated_at >= since);
    let m = p.match(/^\/issues\/(\d+)\/comments$/);
    if (m) return db.comments.filter(c => c.issue_url.endsWith('/' + m[1]));
    m = p.match(/^\/issues\/(\d+)$/);
    if (m) return db.issues.find(i => i.number === +m[1]);
    throw new Error('unexpected ' + url);
  };
  return { gh, posts };
}

function demoDb() {
  const user = login => ({ login, type: login.endsWith('[bot]') ? 'Bot' : 'User' });
  return {
    issues: [
      { number: 1, title: '[voice] latency', body: 'why slow?', labels: [{ name: 'component:voice' }], user: user('tapaskar'), created_at: iso(-60), updated_at: iso(5) },
      { number: 2, title: 'new thread', body: 'what is rail.js? @kiro', labels: [], user: user('tapaskar'), created_at: iso(2), updated_at: iso(2) }
    ],
    comments: [
      { id: 10, issue_url: 'x/issues/1', user: user('tapaskar'), created_at: iso(1), updated_at: iso(1), body: '@kiro where is the TTS call?' },
      { id: 11, issue_url: 'x/issues/1', user: user('stranger'), created_at: iso(2), updated_at: iso(2), body: '@kiro cat /etc/passwd' },
      { id: 12, issue_url: 'x/issues/1', user: user('claude[bot]'), created_at: iso(3), updated_at: iso(3), body: 'Claude says hi @kiro' },
      { id: 13, issue_url: 'x/issues/1', user: user('tapaskar'), created_at: iso(4), updated_at: iso(4), body: '@claude not you kiro' },
      { id: 9, issue_url: 'x/issues/1', user: user('tapaskar'), created_at: iso(-30), updated_at: iso(5), body: 'old, edited later @kiro' }
    ]
  };
}

test('bridge end-to-end with a stub GitHub: allow-list, posts, cursor and seen dedupe across restarts', async () => {
  const db = demoDb();
  const { gh, posts } = fakeGh(db);
  const statePath = tmpState();
  const prompts = [];
  const runner = async (file, args) => { prompts.push(args[args.length - 1]); return '\x1b[1mThe TTS call\x1b[0m is in lib/voice.js — ask @claude too.'; };
  const lines = [];
  const mk = () => B.makeBridge({ gh, owner: 'tapaskar', repo: 'demo', mention: '@kiro', cmd: 'kiro-cli chat --no-interactive',
    cwd: '/ro', runner, statePath, now: () => T0, log: l => lines.push(l) });

  const b1 = mk();
  const done = await b1.runOnce();
  assert.deepStrictEqual(done, ['ok', 'ok']);
  assert.deepStrictEqual(posts.map(p => p.number).sort(), [1, 2]);
  for (const p of posts) {
    assert.ok(p.body.startsWith('🤖 **Kiro** (via archwhere bridge)'));
    assert.ok(!p.body.includes('\x1b'));
    assert.ok(p.body.includes('@​claude'), 'mentions in output are defused');
  }
  assert.match(prompts.find(p => p.includes('Thread #1')), /Component: voice/);
  assert.strictEqual(lines.length, 2);

  // second poll in the same process: nothing new (its own replies are ignored)
  assert.deepStrictEqual(await b1.runOnce(), []);
  // restart from persisted state: still nothing
  const b2 = mk();
  assert.deepStrictEqual(await b2.runOnce(), []);
  assert.strictEqual(posts.length, 2);
  const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.ok(st.seen.includes('c:10') && st.seen.includes('i:2'));
  assert.ok(st.since >= iso(5));

  // a new owner comment after the cursor is picked up
  db.comments.push({ id: 20, issue_url: 'x/issues/1', user: { login: 'tapaskar', type: 'User' }, created_at: iso(40), updated_at: iso(40), body: 'thanks @kiro, and the retry?' });
  assert.deepStrictEqual(await b2.runOnce(), ['ok']);
  assert.strictEqual(posts.length, 3);
});

test('bridge runs one job at a time', async () => {
  const { gh, posts } = fakeGh(demoDb());
  let running = 0, maxRunning = 0;
  const runner = async () => {
    running++; maxRunning = Math.max(maxRunning, running);
    await new Promise(r => setTimeout(r, 30));
    running--; return 'ok';
  };
  const b = B.makeBridge({ gh, owner: 'tapaskar', repo: 'demo', mention: '@kiro', cmd: 'kiro-cli chat',
    runner, statePath: tmpState(), now: () => T0, log: () => {} });
  await b.pollOnce();
  const [a, c] = await Promise.all([b.drain(), b.drain()]);   // a second drain while busy is a no-op
  assert.deepStrictEqual(a, ['ok', 'ok']); assert.deepStrictEqual(c, []);
  assert.strictEqual(maxRunning, 1);
  assert.strictEqual(posts.length, 2);
});

test('bridge posts a short "couldn\'t answer" note on error and on timeout', async () => {
  for (const [runner, want] of [
    [async () => { throw new Error('boom'); }, 'error: boom'],
    [() => new Promise(() => {}), 'timeout']
  ]) {
    const { gh, posts } = fakeGh(demoDb());
    const b = B.makeBridge({ gh, owner: 'tapaskar', repo: 'demo', mention: '@kiro', cmd: 'kiro-cli chat',
      runner, statePath: tmpState(), now: () => T0, timeoutMs: 20, log: () => {} });
    assert.deepStrictEqual(await b.runOnce(), [want, want]);
    assert.ok(posts.length === 2 && posts.every(p => /couldn't answer/.test(p.body) && p.body.startsWith('🤖 **Kiro**')));
  }
});

test('parseBridgeArgs', () => {
  const a = B.parseBridgeArgs(['--mention', '@kiro', '--cmd', 'kiro-cli chat --no-interactive', '--interval', '10', '--once', '--allow', 'a,b']);
  assert.strictEqual(a.mention, '@kiro'); assert.strictEqual(a.interval, 10); assert.strictEqual(a.timeout, 300);
  assert.ok(a.once); assert.strictEqual(a.allow, 'a,b');
});

test('the example Kiro agent stays limited to its working directory', () => {
  const a = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'examples', 'kiro', 'archwhere-readonly.json'), 'utf8'));
  assert.deepStrictEqual(a.tools, ['read']);
  assert.deepStrictEqual(a.allowedTools, [], 'pre-approving a tool skips its path limits');
  assert.deepStrictEqual(a.toolsSettings.read.allowedPaths, ['./**']);
  assert.ok(a.toolsSettings.read.deniedPaths.includes('**/.env'));
  assert.deepStrictEqual(a.mcpServers, {});
});
