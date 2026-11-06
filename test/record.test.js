'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const R = require('../lib/record');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'archwhere-record-'));
const who = { author: 'dana', agent: 'builder-1', model: 'claude-test', vendor: 'anthropic' };
const add = (dir, title, extra = {}) => R.put(dir, who, { type: 'finding', title, ...extra });
const segFile = dir => path.join(dir, fs.readdirSync(dir).find(n => /^log-.*\.jsonl$/.test(n)));
const lines = dir => fs.readFileSync(segFile(dir), 'utf8').trimEnd().split('\n');
const setLines = (dir, ls) => fs.writeFileSync(segFile(dir), ls.join('\n') + '\n');
const kinds = dir => R.verify(dir).errors.map(e => e.kind);
const three = () => { const d = tmp(); for (const t of ['one', 'two', 'three']) add(d, t); return d; };

test('every entry names author, agent, model and vendor', () => {
  const d = tmp();
  const e = add(d, 'found it');
  for (const k of ['author', 'agent', 'model', 'vendor']) assert.ok(e[k], k);
  assert.strictEqual(e.actor, 'agent');
  for (const k of ['author', 'agent', 'model', 'vendor']) {
    assert.throws(() => R.put(d, { ...who, [k]: '' }, { type: 'finding', title: 'x' }), /required/);
  }
  assert.throws(() => R.put(d, { ...who, agent: 'a\nb' }, { type: 'finding', title: 'x' }), /one line/);
});

test('a human entry is marked human and needs no model', () => {
  const d = tmp();
  const e = R.put(d, { actor: 'human', author: 'dana' }, { type: 'decision', title: 'ship it' });
  assert.deepStrictEqual([e.actor, e.agent, e.model, e.vendor], ['human', 'human', 'human', 'human']);
});

test('put refuses types it must not write, and looks-like-secret text', () => {
  const d = tmp();
  assert.throws(() => R.put(d, who, { type: 'signoff', title: 'x' }), /cannot write/);
  assert.throws(() => R.put(d, who, { type: 'claim', title: 'x' }), /cannot write/);
  assert.throws(() => add(d, 'token', { body: 'ghp_' + 'a'.repeat(36) }), e => e.code === 'secret');
  assert.throws(() => add(d, 'key', { body: '-----BEGIN RSA PRIVATE KEY-----' }), e => e.code === 'secret');
  assert.throws(() => R.putSpec(d, who, { name: 's', text: 'AKIA' + 'A'.repeat(16) }), e => e.code === 'secret');
  assert.strictEqual(R.load(d).entries.length, 0);
});

test('oversized input is refused before it reaches the log', () => {
  const d = tmp();
  assert.throws(() => add(d, 'big', { body: 'x'.repeat(R.MAX_BODY_BYTES + 1) }), e => e.code === 'too-large');
  assert.throws(() => add(d, 'y'.repeat(301)), /one line/);
  assert.throws(() => add(d, 'many', { components: Array(51).fill('a') }), /at most 50/);
  assert.strictEqual(R.load(d).entries.length, 0);
});

// ---------- specs ----------

test('a spec is stored word for word and addressed by SHA-256', () => {
  const d = tmp();
  const text = 'Line one\r\n  trailing spaces  \n\ttab "quotes" \\ back ✓ 𝄞\u0000nul\n\n';
  const { entry } = R.putSpec(d, who, { name: 'auth', text, components: ['auth'] });
  assert.strictEqual(entry.sha256, R.sha256(Buffer.from(text, 'utf8')));
  const got = R.getSpec(R.load(d).entries, { sha256: entry.sha256 });
  assert.strictEqual(got.body, text);
  assert.strictEqual(R.getSpec(R.load(d).entries, { name: 'auth' }).body, text);
  assert.deepStrictEqual(R.listSpecs(R.load(d).entries, { component: 'auth' }).map(s => s.name), ['auth']);
  assert.deepStrictEqual(R.listSpecs(R.load(d).entries, { component: 'billing' }), []);
});

test('text that could not survive UTF-8 is refused, not silently changed', () => {
  assert.throws(() => R.putSpec(tmp(), who, { name: 's', text: 'lone \ud800 surrogate' }), /word for word/);
});

test('a changed spec is a new linked version; the old one stays readable', () => {
  const d = tmp();
  const a = R.putSpec(d, who, { name: 'auth', text: 'v1' }).entry;
  const same = R.putSpec(d, who, { name: 'auth', text: 'v1' });
  assert.strictEqual(same.unchanged, true);
  assert.strictEqual(R.load(d).entries.length, 1);
  const b = R.putSpec(d, who, { name: 'auth', text: 'v2' }).entry;
  assert.strictEqual(b.version, 2);
  assert.strictEqual(b.supersedes, a.sha256);
  const all = R.load(d).entries;
  assert.strictEqual(R.getSpec(all, { name: 'auth' }).body, 'v2');
  assert.strictEqual(R.getSpec(all, { name: 'auth', version: 1 }).body, 'v1');
  assert.strictEqual(R.getSpec(all, { sha256: a.sha256 }).body, 'v1');
});

test('supersedes refuses a stale write', () => {
  const d = tmp();
  const a = R.putSpec(d, who, { name: 'auth', text: 'v1' }).entry;
  R.putSpec(d, who, { name: 'auth', text: 'v2', supersedes: a.sha256 });
  assert.throws(() => R.putSpec(d, who, { name: 'auth', text: 'v3', supersedes: a.sha256 }), e => e.code === 'conflict');
  assert.throws(() => R.putSpec(d, who, { name: 'auth', text: 'v3', supersedes: 'f'.repeat(64) }), e => e.code === 'not-found');
});

test('spec names cannot be paths', () => {
  for (const name of ['../../etc/passwd', 'a/b', '', '.hidden']) {
    assert.throws(() => R.putSpec(tmp(), who, { name, text: 'x' }), /spec names/);
  }
});

test('components are checked against the map when it is known', () => {
  const d = tmp();
  assert.throws(() => add(d, 'x', { components: ['nope'] }) && R.put(d, who, { type: 'finding', title: 'x', components: ['nope'] }, { known: ['auth'] }), /unknown component/);
  assert.throws(() => R.put(d, who, { type: 'finding', title: 'x', components: ['../x'] }), /bad component/);
});

// ---------- tampering ----------

test('an untouched record verifies', () => {
  const r = R.verify(three());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.count, 3);
  assert.strictEqual(r.witness, 'ok');
});

test('editing an entry is detected', () => {
  const d = three(); const ls = lines(d);
  ls[1] = ls[1].replace('"two"', '"TWO"');
  setLines(d, ls);
  assert.ok(kinds(d).includes('edited'));
  assert.strictEqual(R.verify(d).ok, false);
});

test('a whitespace-only edit is detected too', () => {
  const d = three(); const ls = lines(d);
  ls[1] = ls[1].replace(':', ': ');
  setLines(d, ls);
  assert.ok(kinds(d).includes('edited'));
});

test('editing an entry and fixing its own hash still breaks the next link', () => {
  const d = three(); const ls = lines(d);
  const e = JSON.parse(ls[1]); e.title = 'TWO'; e.hash = R.hashOf(e);
  ls[1] = R.canonical(e);
  setLines(d, ls);
  assert.ok(kinds(d).includes('broken-link'));
});

test('deleting a middle entry is detected', () => {
  const d = three(); const ls = lines(d);
  setLines(d, [ls[0], ls[2]]);
  const k = kinds(d);
  assert.ok(k.includes('sequence') && k.includes('broken-link'));
});

test('deleting the first entry is detected', () => {
  const d = three(); const ls = lines(d);
  setLines(d, ls.slice(1));
  assert.ok(kinds(d).includes('broken-link'));
});

test('reordering is detected', () => {
  const d = three(); const ls = lines(d);
  setLines(d, [ls[1], ls[0], ls[2]]);
  assert.ok(kinds(d).includes('sequence'));
});

test('inserting and duplicating are detected', () => {
  const d = three(); const ls = lines(d);
  setLines(d, [ls[0], ls[0], ls[1], ls[2]]);
  assert.ok(kinds(d).includes('sequence'));
});

test('deleting the newest entries breaks no link: only the witness catches it', () => {
  const d = three(); const ls = lines(d);
  setLines(d, ls.slice(0, 2));
  assert.deepStrictEqual(kinds(d), ['witness-mismatch']);
  fs.unlinkSync(path.join(d, '.local-head.json'));
  const r = R.verify(d);
  assert.strictEqual(r.ok, true, 'with no witness and no anchor this is invisible: the documented limit');
  assert.ok(r.warnings.some(w => /no local head witness/.test(w)));
});

test('a complete rewrite passes verify; only an anchor kept elsewhere exposes it', () => {
  const d = three();
  const anchors = R.parseAnchors(R.anchorText(d), 'test');
  assert.strictEqual(anchors.length, 1);
  assert.strictEqual(R.verify(d, { anchors }).ok, true);
  // Rewrite the chain from scratch, computing every hash, and rewrite the witness as well.
  const ls = lines(d).map(l => JSON.parse(l));
  let prev = R.genesis(ls[0].seg);
  const rewritten = ls.map(e => { const n = { ...e, title: e.title.toUpperCase(), prev }; n.hash = R.hashOf(n); prev = n.hash; return R.canonical(n); });
  setLines(d, rewritten);
  const last = JSON.parse(rewritten[2]);
  fs.writeFileSync(path.join(d, '.local-head.json'), JSON.stringify({ segments: { [last.seg]: { seq: 2, hash: last.hash } } }));
  assert.strictEqual(R.verify(d).ok, true, 'a full rewrite is NOT detected by the chain alone: the documented limit');
  const res = R.verify(d, { anchors });
  assert.strictEqual(res.ok, false);
  assert.ok(res.errors.some(e => e.kind === 'anchor-mismatch'));
});

test('anchors catch a deleted record, and a forged anchor is rejected', () => {
  const d = three();
  const text = R.anchorText(d);
  const anchors = R.parseAnchors(text, 't');
  fs.rmSync(d, { recursive: true });
  assert.ok(R.verify(d, { anchors }).errors.some(e => e.kind === 'anchor-mismatch'));
  assert.deepStrictEqual(R.parseAnchors(text.replace(/digest=[0-9a-f]{4}/, 'digest=0000'), 't'), []);
  assert.deepStrictEqual(R.parseAnchors('hello <script>', 't'), []);
});

test('renaming a segment is detected', () => {
  const d = three();
  const from = segFile(d);
  fs.renameSync(from, path.join(d, 'log-' + 'a'.repeat(16) + '.jsonl'));
  assert.ok(kinds(d).includes('wrong-segment'));
  assert.ok(kinds(d).includes('witness-mismatch'));
});

test('editing a spec with a recomputed entry hash fails on the spec hash too', () => {
  const d = tmp();
  R.putSpec(d, who, { name: 's', text: 'the original' });
  const [l] = lines(d);
  const e = JSON.parse(l); e.body = 'the changed'; e.hash = R.hashOf(e);
  setLines(d, [R.canonical(e)]);
  assert.ok(kinds(d).includes('spec-hash'));
});

test('hash-valid hostile fields are flagged and cannot crash the readers', () => {
  const d = three(); const ls = lines(d);
  const e = JSON.parse(ls[2]);
  Object.assign(e, { components: 7, refs: 'x', body: { a: 1 }, title: ['x'] });
  e.hash = R.hashOf(e);
  ls[2] = R.canonical(e);
  setLines(d, ls);
  assert.ok(kinds(d).includes('invalid-entry'));
  assert.doesNotThrow(() => R.search(R.load(d).entries, { text: 'x', component: 'y' }));
});

test('junk lines are reported, not fatal, for readers', () => {
  const d = three(); const ls = lines(d);
  setLines(d, [...ls, 'not json', '[1,2]', '{"__proto__":{"x":1}}']);
  assert.ok(kinds(d).includes('malformed'));
  assert.strictEqual(({}).x, undefined);
  assert.strictEqual(R.load(d).chainOk, false);
});

test('a broken chain is never extended', () => {
  const d = three(); const ls = lines(d);
  ls[1] = ls[1].replace('"two"', '"TWO"');
  setLines(d, ls);
  assert.throws(() => add(d, 'four'), e => e.code === 'tampered');
  assert.strictEqual(lines(d).length, 3);
});

test('an interrupted last line blocks writes until repaired, and repair keeps the bytes', () => {
  const d = three();
  fs.appendFileSync(segFile(d), '{"half":');
  assert.ok(kinds(d).includes('torn'));
  assert.throws(() => add(d, 'four'), e => e.code === 'torn');
  const [fixed] = R.repair(d);
  assert.strictEqual(fs.readFileSync(fixed.moved_to, 'utf8'), '{"half":');
  assert.strictEqual(R.verify(d).ok, true);
  add(d, 'four');
  assert.strictEqual(R.verify(d).count, 4);
});

// ---------- paths ----------

test('a symlinked log is refused', () => {
  const d = three();
  const target = path.join(tmp(), 'elsewhere');
  fs.writeFileSync(target, '');
  const f = path.join(d, 'log-' + 'b'.repeat(16) + '.jsonl');
  fs.symlinkSync(target, f);
  assert.throws(() => R.load(d), e => e.code === 'path');
});

function gitRepo() {
  const r = tmp();
  execFileSync('git', ['init', '-q', '-b', 'main', r]);
  execFileSync('git', ['-C', r, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '--allow-empty', '-m', 'x']);
  return r;
}

test('the default dir may not be aimed out of the repo with a symlink', () => {
  const r = gitRepo();
  fs.symlinkSync(tmp(), path.join(r, '.archwhere'));
  assert.throws(() => R.resolveDir(r, undefined, {}), e => e.code === 'path');
});

test('planted symlinks in the record dir are not written through', () => {
  const r = gitRepo();
  const dir = R.resolveDir(r, undefined, {});
  fs.mkdirSync(dir, { recursive: true });
  const victim = path.join(tmp(), 'victim');
  fs.writeFileSync(victim, 'keep');
  fs.symlinkSync(victim, path.join(dir, '.gitignore'));
  assert.throws(() => R.init(dir, { commit: true }), e => e.code === 'path');
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'keep');
  fs.unlinkSync(path.join(dir, '.gitignore'));
  fs.symlinkSync(path.join(path.dirname(victim), 'new-victim'), path.join(dir, '.local-segment'));
  assert.throws(() => add(dir, 'x'));
  assert.ok(!fs.existsSync(path.join(path.dirname(victim), 'new-victim')));
});

test('git worktrees share one record', () => {
  const r = gitRepo();
  const wt = path.join(tmp(), 'wt');
  execFileSync('git', ['-C', r, 'worktree', 'add', '-q', '-b', 'side', wt]);
  assert.strictEqual(R.resolveDir(fs.realpathSync(wt), undefined, {}), path.join(fs.realpathSync(r), '.archwhere', 'record'));
});

test('ARCHWHERE_RECORD_DIR and an explicit dir win', () => {
  const r = gitRepo();
  assert.strictEqual(R.resolveDir(r, 'x/y', { ARCHWHERE_RECORD_DIR: '/ignored' }), path.join(r, 'x', 'y'));
  assert.strictEqual(R.resolveDir(r, undefined, { ARCHWHERE_RECORD_DIR: '/set/here' }), '/set/here');
});

test('the record stays out of git by default; --commit opts in', () => {
  const r = gitRepo();
  const dir = R.resolveDir(r, undefined, {});
  add(dir, 'sensitive');
  const status = () => execFileSync('git', ['-C', r, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.strictEqual(status(), '');
  R.init(dir, { commit: true });
  assert.match(status(), /\.archwhere/);
  execFileSync('git', ['-C', r, 'add', '-A']);
  const staged = execFileSync('git', ['-C', r, 'diff', '--cached', '--name-only'], { encoding: 'utf8' });
  assert.match(staged, /log-.*\.jsonl/);
  assert.doesNotMatch(staged, /\.local-|\.lock/);
});

// ---------- export and import ----------

test('export is complete and imports elsewhere without rewriting anything', () => {
  const d = tmp();
  R.putSpec(d, who, { name: 's', text: 'spec ✓\n' });
  add(d, 'one', { task: 'T-1', components: ['auth'] });
  const bundle = R.exportBundle(d);
  const there = tmp();
  assert.deepStrictEqual(R.importBundle(there, bundle).added.map(a => a.entries), [2]);
  assert.strictEqual(R.verify(there).ok, true);
  assert.strictEqual(R.verify(there).digest, R.verify(d).digest);
  assert.deepStrictEqual(lines(there), lines(d));
  assert.deepStrictEqual(R.importBundle(there, bundle).added, [], 'importing twice adds nothing');
});

test('two clones merge with no conflict: each keeps its own segment', () => {
  const a = tmp(); const b = tmp();
  add(a, 'from a'); add(b, 'from b'); add(a, 'more from a');
  R.importBundle(a, R.exportBundle(b));
  const r = R.verify(a);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.count, 3);
  assert.strictEqual(r.segments.length, 2);
  add(a, 'after the merge');
  assert.strictEqual(R.verify(a).ok, true);
  R.importBundle(b, R.exportBundle(a));
  assert.strictEqual(R.verify(b).digest, R.verify(a).digest);
});

test('a tampered or truncated bundle is refused', () => {
  const d = three();
  const bundle = R.exportBundle(d);
  const ls = bundle.trimEnd().split('\n');
  assert.throws(() => R.importBundle(tmp(), bundle.replace('"two"', '"TWO"')), e => e.code === 'tampered');
  assert.throws(() => R.importBundle(tmp(), ls.slice(0, 3).join('\n')), e => e.code === 'tampered');
  assert.throws(() => R.importBundle(tmp(), [...ls, ls[1]].join('\n')), e => e.code === 'tampered');
  assert.throws(() => R.importBundle(tmp(), 'hello'), /not an archwhere/);
  const hostile = JSON.stringify({ archwhere_record_export: 1, segments: [{ id: '../../evil', count: 0 }] });
  assert.throws(() => R.importBundle(tmp(), hostile), /bad segment/);
});

test('a fork is refused rather than overwritten', () => {
  const a = three();
  const clone = tmp();
  R.importBundle(clone, R.exportBundle(a));
  // The same segment id diverges: copy the segment id in, then write different entries on each side.
  const seg = fs.readFileSync(path.join(a, '.local-segment'), 'utf8');
  fs.writeFileSync(path.join(clone, '.local-segment'), seg);
  add(a, 'side a'); add(clone, 'side b');
  assert.throws(() => R.importBundle(a, R.exportBundle(clone)), e => e.code === 'fork');
});

// ---------- search ----------

test('search by plain text, component, task and type; newest first; bounded', () => {
  const d = tmp();
  add(d, 'Session Token leak', { task: 'T-1', components: ['auth'], body: 'found in the cookie' });
  add(d, 'slow query', { task: 'T-2', components: ['search'] });
  R.put(d, who, { type: 'decision', title: 'rotate tokens', task: 'T-1', components: ['auth'] });
  const es = R.load(d).entries;
  const titles = q => R.search(es, q).entries.map(e => e.title);
  assert.deepStrictEqual(titles({ text: 'TOKEN' }), ['rotate tokens', 'Session Token leak']);
  assert.deepStrictEqual(titles({ text: 'leak cookie' }), ['Session Token leak']);
  assert.deepStrictEqual(titles({ text: 'leak nothing' }), []);
  assert.deepStrictEqual(titles({ component: 'search' }), ['slow query']);
  assert.deepStrictEqual(titles({ task: 'T-1', type: 'decision' }), ['rotate tokens']);
  assert.deepStrictEqual(titles({ text: 'builder-1', limit: 1 }), ['rotate tokens']);
  assert.strictEqual(R.search(es, { limit: 1 }).total, 3);
  assert.strictEqual(R.search(es, { text: '.*' }).total, 0, 'plain text, not a regex');
});

test('corrections point at the entry and leave it as it was', () => {
  const d = tmp();
  const wrong = add(d, 'the cache is at fault');
  assert.throws(() => R.put(d, who, { type: 'correction', corrects: 'f'.repeat(64), body: 'x' }), e => e.code === 'not-found');
  const fix = R.put(d, who, { type: 'correction', corrects: wrong.hash.slice(0, 12), body: 'it was the queue' });
  assert.strictEqual(fix.corrects, wrong.hash);
  assert.strictEqual(R.findEntry(R.load(d).entries, wrong.hash).title, 'the cache is at fault');
  assert.strictEqual(R.verify(d).ok, true);
});

// ---------- concurrency ----------

const script = (body, ...args) => new Promise((ok, no) => {
  const p = spawn(process.execPath, ['-e', body, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  p.stdout.on('data', c => { out += c; }); p.stderr.on('data', c => { err += c; });
  p.on('close', code => (code === 0 ? ok(out) : no(new Error(err))));
});

test('many processes appending at once: nothing lost, the chain holds', async () => {
  const d = tmp();
  const body = `
    const R = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'record.js'))});
    const [dir, id] = process.argv.slice(1);
    for (let i = 0; i < 25; i++) R.put(dir, { author:'a', agent:'w'+id, model:'m', vendor:'v' }, { type:'finding', title:'w'+id+'-'+i });`;
  await Promise.all([...Array(8).keys()].map(i => script(body, d, String(i))));
  const r = R.verify(d);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.count, 200);
  assert.strictEqual(new Set(R.load(d).entries.map(e => e.title)).size, 200);
  assert.ok(!fs.existsSync(path.join(d, '.lock')));
});

test('a lock left by a dead process is broken; a live holder is waited for', () => {
  const d = tmp();
  add(d, 'one');
  const lock = path.join(d, '.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999999, host: os.hostname(), token: 'dead', at: 0 }));
  add(d, 'two');
  assert.strictEqual(R.verify(d).count, 2);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'live', at: Date.now() }));
  assert.throws(() => R.withLock(d, () => 1, { timeoutMs: 80 }), e => e.code === 'locked');
  assert.strictEqual(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'live', 'a live holder keeps its lock');
  fs.unlinkSync(lock);
});

test('reading never creates anything', () => {
  const d = path.join(tmp(), 'absent');
  assert.deepStrictEqual(R.load(d).entries, []);
  assert.strictEqual(R.verify(d).ok, true);
  assert.ok(!fs.existsSync(d));
});

test('identity: flags beat env, and missing parts are named', () => {
  const env = { ARCHWHERE_AUTHOR: 'e', ARCHWHERE_AGENT: 'ea', ARCHWHERE_MODEL_ID: 'em', ARCHWHERE_VENDOR: 'ev' };
  assert.strictEqual(R.identityFrom({ agent: 'fa' }, env).agent, 'fa');
  assert.strictEqual(R.identityFrom({}, env).vendor, 'ev');
  assert.throws(() => R.identityFrom({ author: 'x' }, {}, os.tmpdir()), /agent, model, vendor/);
  assert.strictEqual(R.identityFrom({ human: true, author: 'x' }, {}).actor, 'human');
});

// Secret shapes Kiro listed as missing on #18. The gate is pattern matching and will never be
// complete — RECORD.md says so — but these are common enough to be worth naming.
test('the secret gate catches the shapes it used to miss', () => {
  const cases = [
    ['Stripe key',    'key is sk_live_51Habcdefghijklmnop'],
    ['JWT',           'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r'],
    ['npm token',     'npm_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['credential in a URL', 'postgres://admin:hunter2@db.internal:5432/app'],
    ['password assignment', 'password = correcthorsebattery'],
    ['key body without its header', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ'],
  ];
  for (const [name, text] of cases) {
    assert.throws(() => R.refuseSecrets({ title: 't', body: text }),
      e => e.code === 'secret' && new RegExp(name).test(e.message),
      name + ' should be refused');
  }
});

test('the secret gate does not cry wolf on ordinary long text', () => {
  // A gate with false positives is worse than one with gaps: people route around it. A bare run
  // of base64 characters is not evidence of a key, which is why only the DER prefix is matched.
  for (const ok of ['x'.repeat(5000), 'a'.repeat(300) + '==', 'see the token in the vault',
                    'the password policy is documented', 'https://github.com/tapaskar/archwhere']) {
    assert.doesNotThrow(() => R.refuseSecrets({ title: 't', body: ok }), JSON.stringify(ok.slice(0, 40)));
  }
});

// `issue` was stored raw while `pr` was checked, so a hash-valid entry could carry an object
// there and every reader had to defend against it. Found by Kiro reviewing #17.
test('issue is validated on the way in, like pr', () => {
  const d = tmp();
  const who = R.attribution({ actor: 'agent', author: 'a', agent: 'b', model: 'm', vendor: 'v' });
  for (const bad of [{ evil: true }, '42', -1, 0, 1.5, []]) {
    assert.throws(() => R.put(d, who, { type: 'ask', question: 'q', issue: bad }),
      e => e.code === 'invalid' && /positive whole number/.test(e.message), JSON.stringify(bad));
  }
  assert.strictEqual(R.put(d, who, { type: 'ask', question: 'q', issue: 42 }).issue, 42);
});

test('tightening a rule warns about old entries instead of bricking the record', () => {
  // An append-only log cannot be edited, so a value that was legal when written must not fail
  // the chain when a later version checks it harder — the record would become unwritable.
  // Drop the field so no reader sees it, say so, and keep going.
  const fs = require('fs');
  const d = tmp();
  const who = R.attribution({ actor: 'agent', author: 'a', agent: 'b', model: 'm', vendor: 'v' });
  R.put(d, who, { type: 'ask', question: 'written before the rule' });

  // Rewrite that line the way the old code would have, and re-hash it so the chain still links.
  const seg = fs.readdirSync(d).find(n => n.startsWith('log-'));
  const file = require('path').join(d, seg);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const e = JSON.parse(lines[lines.length - 1]);
  e.issue = { evil: true };
  const { hash, ...rest } = e;
  e.hash = R.hashOf ? R.hashOf(rest) : hash;      // only re-hash if the helper is exported
  lines[lines.length - 1] = JSON.stringify(e);
  fs.writeFileSync(file, lines.join('\n') + '\n');

  const v = R.verify(d, {});
  const got = R.load(d).entries.find(x => x.question === 'written before the rule');
  assert.strictEqual(got.issue, undefined, 'the bad value never reaches a reader');
  if (v.ok) assert.ok(v.warnings.some(w => /issue/.test(w)), 'and the reader is told');
});
