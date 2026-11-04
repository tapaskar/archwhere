'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const R = require('../lib/record');
const S = require('../lib/signoff');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'archwhere-signoff-'));
const PASS = 'correct horse battery';
const agent = { author: 'dana', agent: 'b1', model: 'claude-x', vendor: 'anthropic' };

function setup() {
  const d = tmp();
  const keyPath = path.join(tmp(), 'k.pem');
  const key = S.keygen({ name: 'dana', passphrase: PASS, keyPath });
  const decision = R.put(d, agent, { type: 'decision', title: 'use Postgres' });
  return { d, keyPath, key, decision, signers: [{ name: 'dana', key_id: key.key_id, public_key: key.public_key }] };
}
const sign = (s, extra = {}) => S.signoff(s.d, { target: s.decision.hash, decision: 'approve', signer: 'dana', keyPath: s.keyPath, passphrase: PASS, ...extra });

test('keygen: passphrase-protected, private mode, never overwrites, never in the repo', () => {
  const dir = tmp();
  const keyPath = path.join(dir, 'k.pem');
  S.keygen({ name: 'dana', passphrase: PASS, keyPath });
  const pem = fs.readFileSync(keyPath, 'utf8');
  assert.match(pem, /ENCRYPTED PRIVATE KEY/);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(keyPath).mode & 0o777, 0o600);
  assert.throws(() => S.keygen({ name: 'dana', passphrase: PASS, keyPath }), /EEXIST/);
  assert.throws(() => S.keygen({ name: 'dana', passphrase: 'short', keyPath: keyPath + '2' }), /at least/);
  assert.throws(() => S.keygen({ name: '../x', passphrase: PASS, keyPath: keyPath + '3' }), /signer names/);
  assert.throws(() => S.keygen({ name: 'dana', passphrase: PASS, keyPath: path.join(dir, 'r', 'k.pem'), root: dir }), e => e.code === 'path');
});

test('a sign-off verifies against the trusted key, and marks the entry', () => {
  const s = setup();
  const e = sign(s, { note: 'agreed' });
  assert.strictEqual(e.actor, 'human');
  const res = R.verify(s.d, { signers: s.signers });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.signoffs[0].status, 'verified');
  const who = S.whoMade(s.decision, res.signoffs);
  assert.strictEqual(who.made_by, 'agent');
  assert.deepStrictEqual(who.signed_by.map(x => [x.signer, x.decision]), [['dana', 'approve']]);
  assert.strictEqual(S.whoMade(e, res.signoffs).made_by, 'human-signed');
});

test('wrong passphrase and unprotected keys cannot sign', () => {
  const s = setup();
  assert.throws(() => sign(s, { passphrase: 'wrong wrong wrong' }), e => e.code === 'passphrase');
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const plain = path.join(tmp(), 'plain.pem');
  fs.writeFileSync(plain, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  assert.throws(() => sign(s, { keyPath: plain }), /not passphrase-protected/);
  assert.strictEqual(R.load(s.d).entries.filter(e => e.type === 'signoff').length, 0);
});

test('an agent forging a sign-off with its own key shows as unknown; with no trust list, too', () => {
  const s = setup();
  const forgerKey = path.join(tmp(), 'forger.pem');
  S.keygen({ name: 'dana', passphrase: PASS, keyPath: forgerKey });
  sign(s, { keyPath: forgerKey });
  const res = R.verify(s.d, { signers: s.signers });
  assert.strictEqual(res.signoffs[0].status, 'unknown-key');
  assert.ok(res.warnings.some(w => /not in the trusted signers/.test(w)));
  assert.strictEqual(S.whoMade(s.decision, res.signoffs).signed_by, undefined);
  assert.strictEqual(S.whoMade(res.signoffs[0], res.signoffs).made_by, 'human-unverified');
  assert.strictEqual(R.verify(s.d).signoffs[0].status, 'unknown-key');
});

test('a signature with no key behind it fails: signature and target are both covered', () => {
  const s = setup();
  const other = R.put(s.d, agent, { type: 'decision', title: 'use Mongo' });
  const good = sign(s);
  // Copy a real signature onto a forged entry for a different target, with the chain done correctly.
  R.transact(s.d, ctx => ctx.add({ type: 'signoff', attr: { actor: 'human', author: 'dana' },
    target: other.hash, decision: 'approve', signer: 'dana', key_id: good.key_id, signed_at: good.signed_at, signature: good.signature }));
  const res = R.verify(s.d, { signers: s.signers });
  assert.strictEqual(res.ok, false);
  assert.ok(res.errors.some(e => e.kind === 'bad-signature'));
  assert.strictEqual(S.whoMade(other, res.signoffs).signed_by, undefined);
});

test('changing a signed note or decision is caught even with the chain recomputed', () => {
  const s = setup();
  sign(s, { note: 'with conditions' });
  const file = path.join(s.d, fs.readdirSync(s.d).find(n => /^log-/.test(n)));
  const ls = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  const e = JSON.parse(ls[1]); e.decision = 'reject'; e.hash = R.hashOf(e);
  ls[1] = R.canonical(e);
  fs.writeFileSync(file, ls.join('\n') + '\n');
  fs.unlinkSync(path.join(s.d, '.local-head.json'));
  assert.ok(R.verify(s.d, { signers: s.signers }).errors.some(x => x.kind === 'bad-signature'));
});

test('a plain "human" entry stays an unsigned claim', () => {
  const s = setup();
  const e = R.put(s.d, { actor: 'human', author: 'dana' }, { type: 'decision', title: 'trust me' });
  assert.strictEqual(S.whoMade(e, []).made_by, 'human-unsigned');
});

test('no signing over a broken record, or of an entry that is not there', () => {
  const s = setup();
  assert.throws(() => sign(s, { target: 'f'.repeat(64) }), e => e.code === 'not-found');
  assert.throws(() => sign(s, { decision: 'maybe' }), /decision must be/);
  R.put(s.d, agent, { type: 'finding', title: 'two' });
  const file = path.join(s.d, fs.readdirSync(s.d).find(n => /^log-/.test(n)));
  const ls = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  fs.writeFileSync(file, [ls[1], ls[0]].join('\n') + '\n');
  assert.throws(() => sign(s), /tampered|does not verify|verify/);
});

test('the trust list comes from the default branch before the working tree', () => {
  const r = tmp();
  const g = (...a) => execFileSync('git', ['-C', r, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(r, 'arch'));
  const file = path.join(r, S.SIGNERS_FILE);
  fs.writeFileSync(file, JSON.stringify({ signers: [{ name: 'owner', public_key: 'AAAA' }] }));
  assert.deepStrictEqual([S.loadSigners(r).weak, S.loadSigners(r).signers[0].name], [true, 'owner']);
  g('add', '-A'); g('commit', '-q', '-m', 'x');
  g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  // An agent adds its own key in the working tree: not trusted.
  fs.writeFileSync(file, JSON.stringify({ signers: [{ name: 'owner', public_key: 'AAAA' }, { name: 'agent', public_key: 'BBBB' }] }));
  const t = S.loadSigners(r);
  assert.strictEqual(t.weak, false);
  assert.strictEqual(t.source, 'origin/main:arch/record-signers.json');
  assert.deepStrictEqual(t.signers.map(x => x.name), ['owner']);
  assert.deepStrictEqual(S.loadSigners(tmp()).signers, []);
});

test('the CLI will not take a passphrase without a terminal', () => {
  const s = setup();
  const r = spawnSync('setsid', ['-w', process.execPath, path.join(__dirname, '..', 'bin', 'archwhere.js'), 'record', 'signoff', '--dir', s.d,
    '--target', s.decision.hash, '--decision', 'approve', '--signer', 'dana', '--key', s.keyPath], { input: PASS + '\n', encoding: 'utf8', cwd: tmp() });
  if (r.error && r.error.code === 'ENOENT') return; // no setsid on this system
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /terminal/);
  assert.strictEqual(R.load(s.d).entries.filter(e => e.type === 'signoff').length, 0);
});
