'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const Guard = require('../lib/guard');
const W = require('../lib/where');

const CLI = path.join(__dirname, '..', 'bin', 'archwhere.js');
const MODEL = {
  system: 'Meridian',
  components: {
    auth: { name: 'Auth', kind: 'security', paths: ['core/auth/**'], watch: [{ pattern: 'session|token', note: 'security review' }], deps: [] },
    billing: { name: 'Billing', kind: 'feature', paths: ['features/billing/**'], watch: [{ pattern: 'refund', note: 'money' }], deps: [] },
    web: { name: 'Web', kind: 'product', paths: ['web/**'], deps: [] },
    repo: { name: 'Repo', kind: 'ops', paths: ['arch/**', '.github/**', '*.md'], deps: [] },
  },
  flows: {},
};
const clone = x => JSON.parse(JSON.stringify(x));
const FILES = ['core/auth/session.js', 'core/auth/rbac.js', 'features/billing/refund.js', 'web/app.js'];
const codes = (a, b, files = FILES) => Guard.modelWeakenings(a, b, files).map(w => `${w.code}:${w.component}`);

test('an unchanged model, or one that only adds review, weakens nothing', () => {
  assert.deepStrictEqual(codes(MODEL, clone(MODEL)), []);
  const more = clone(MODEL);
  more.components.web.watch = [{ pattern: 'cookie', note: 'x' }];
  more.components.web.kind = 'security';
  assert.deepStrictEqual(codes(MODEL, more), []);
});

test('reclassifying a security component is a weakening', () => {
  const m = clone(MODEL); m.components.auth.kind = 'feature';
  assert.deepStrictEqual(codes(MODEL, m), ['kind-downgraded:auth']);
});

test('a different spelling of the kind is still a reclassification', () => {
  const m = clone(MODEL); m.components.auth.kind = 'Security';
  assert.ok(codes(MODEL, m).includes('kind-downgraded:auth'));
});

test('removing a security component, or a watched one, is a weakening', () => {
  const m = clone(MODEL); delete m.components.auth; delete m.components.billing;
  assert.deepStrictEqual(codes(MODEL, m), ['zone-removed:auth', 'zone-removed:billing']);
});

test('dropping or rewriting a watch pattern is a weakening', () => {
  const m = clone(MODEL);
  m.components.auth.watch = [{ pattern: 'session', note: 'security review' }];
  delete m.components.billing.watch;
  assert.deepStrictEqual(codes(MODEL, m), ['watch-removed:auth', 'watch-removed:billing']);
});

test('a malformed watch list is treated as no watch list', () => {
  const m = clone(MODEL); m.components.auth.watch = 'session';
  assert.deepStrictEqual(codes(MODEL, m), ['watch-removed:auth']);
});

test('another component stealing a file with a longer glob is a weakening', () => {
  const m = clone(MODEL); m.components.web.paths.push('core/auth/session.js');
  const [w] = Guard.modelWeakenings(MODEL, m, FILES);
  assert.strictEqual(w.code, 'zone-narrowed');
  assert.match(w.message, /core\/auth\/session\.js/);
  assert.match(w.message, /to \*\*Web\*\*/);
});

test('narrowing a zone\'s own globs is a weakening; moving files to another zone that keeps the review is not', () => {
  const narrowed = clone(MODEL); narrowed.components.auth.paths = ['core/auth/rbac.js'];
  assert.deepStrictEqual(codes(MODEL, narrowed), ['zone-narrowed:auth']);
  const split = clone(MODEL);
  split.components['auth-rbac'] = { name: 'RBAC', kind: 'security', paths: ['core/auth/rbac.js'], watch: clone(MODEL.components.auth.watch), deps: [] };
  assert.deepStrictEqual(codes(MODEL, split), []);
});

test('parseLabels reads the action\'s JSON and a plain list', () => {
  assert.deepStrictEqual(Guard.parseLabels('[\n  "a",\n  "owner-review"\n]'), ['a', 'owner-review']);
  assert.deepStrictEqual(Guard.parseLabels('a, b'), ['a', 'b']);
  assert.deepStrictEqual(Guard.parseLabels('[]'), []);
  assert.strictEqual(Guard.parseLabels(undefined), null);
});

test('GATE_FILE covers workflows and CODEOWNERS, nothing else', () => {
  for (const f of ['.github/workflows/ci.yml', 'CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS']) assert.ok(Guard.GATE_FILE.test(f), f);
  for (const f of ['.github/dependabot.yml', 'web/CODEOWNERS', 'src/.github/workflows/x.yml']) assert.ok(!Guard.GATE_FILE.test(f), f);
});

// ---- End to end: a real repo, a real branch, the real CLI.

function repo(model = MODEL) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archwhere-guard-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.test'); g('config', 'user.name', 'T');
  const write = (f, text) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); };
  write('arch/architecture.json', JSON.stringify(model, null, 2));
  write('core/auth/session.js', 'module.exports = 1;\n');
  write('core/auth/rbac.js', 'module.exports = 2;\n');
  write('features/billing/refund.js', 'module.exports = 3;\n');
  write('web/app.js', 'module.exports = 4;\n');
  write('README.md', 'hi\n');
  g('add', '-A'); g('commit', '-qm', 'base');
  g('checkout', '-qb', 'pr');
  const commit = () => { g('add', '-A'); g('commit', '-qm', 'pr'); };
  const check = (...args) => {
    const env = { ...process.env }; delete env.ARCHWHERE_PR_LABELS; delete env.ARCHWHERE_MODEL;
    const r = spawnSync('node', [CLI, 'check', '--base', 'main', ...args], { cwd: dir, encoding: 'utf8', env });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const map = (...args) => spawnSync('node', [CLI, 'map', '--base', 'main', ...args], { cwd: dir, encoding: 'utf8' }).stdout;
  const editModel = fn => { const m = JSON.parse(fs.readFileSync(path.join(dir, 'arch/architecture.json'), 'utf8')); fn(m); write('arch/architecture.json', JSON.stringify(m, null, 2)); };
  return { dir, g, write, commit, check, map, editModel };
}

test('a plain change outside any zone passes with no label', () => {
  const r = repo(); r.write('web/app.js', 'module.exports = 40;\n'); r.commit();
  const c = r.check('--labels', '');
  assert.strictEqual(c.code, 0, c.out);
});

test('a PR that changes a security component fails without owner-review, passes with it', () => {
  const r = repo(); r.write('core/auth/rbac.js', 'module.exports = 20;\n'); r.commit();
  const no = r.check('--labels', 'enhancement');
  assert.strictEqual(no.code, 1);
  assert.match(no.out, /Auth is a security component/);
  assert.match(no.out, /owner-review/);
  assert.strictEqual(r.check('--labels', 'enhancement,owner-review').code, 0);
});

test('ATTACK: reclassify the security component in the same PR that changes it', () => {
  const r = repo();
  r.editModel(m => { m.components.auth.kind = 'feature'; });
  r.write('core/auth/session.js', 'module.exports = "no auth";\n');
  r.commit();
  const c = r.check('--labels', '');
  assert.strictEqual(c.code, 1, c.out);
  assert.match(c.out, /weakens the map: Auth was reclassified from security to feature/);
  assert.match(c.out, /Auth is a security component/, 'the flag comes from the base model too');
  const md = r.map('--format', 'md');
  assert.match(md, /\[!CAUTION\]/);
  assert.match(md, /This PR weakens the architecture map/);
  assert.match(md, /reclassified from security to feature/);
});

test('ATTACK: the watch pattern is deleted in the PR whose diff would have fired it', () => {
  const r = repo();
  r.editModel(m => { delete m.components.billing.watch; });
  r.write('features/billing/refund.js', 'const refund = 1;\n');
  r.commit();
  const c = r.check('--labels', '');
  assert.strictEqual(c.code, 1);
  assert.match(c.out, /lost its watch pattern refund/);
  assert.match(c.out, /Billing: money/);
});

test('ATTACK: a longer glob moves a security file to a harmless component', () => {
  const r = repo();
  r.editModel(m => { m.components.web.paths.push('core/auth/session.js'); });
  r.write('core/auth/session.js', 'module.exports = "bypass";\n');
  r.commit();
  const c = r.check('--labels', '');
  assert.strictEqual(c.code, 1);
  assert.match(c.out, /left Auth to Web/);
});

test('ATTACK: move the model so the tool reads a replacement', () => {
  const r = repo();
  const weak = clone(MODEL); weak.components.auth.kind = 'feature';
  weak.components.repo.paths.push('architecture.json');
  r.g('rm', '-q', 'arch/architecture.json');
  r.write('architecture.json', JSON.stringify(weak));
  r.commit();
  const c = r.check('--labels', '');
  assert.strictEqual(c.code, 1, c.out);
  assert.match(c.out, /the model moved from arch\/architecture\.json to architecture\.json/);
  assert.match(c.out, /reclassified/);
});

test('ATTACK: move a file out of the zone instead of editing the model', () => {
  const r = repo();
  r.g('mv', 'core/auth/session.js', 'web/session.js');
  r.commit();
  const c = r.check('--labels', '');
  assert.strictEqual(c.code, 1, c.out);
  assert.match(c.out, /Auth is a security component/);
});

test('ATTACK: edit the workflow that runs these checks', () => {
  const r = repo();
  r.write('.github/workflows/archwhere.yml', 'name: nothing\n');
  r.commit();
  const c = r.check('--labels', '');
  assert.strictEqual(c.code, 1, c.out);
  assert.match(c.out, /edits \.github\/workflows\/archwhere\.yml/);
});

test('a watch pattern fires on changed lines only, not on filenames or neighbouring lines', () => {
  const r = repo();
  r.write('features/billing/refund.js', 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  r.g('add', '-A'); r.g('commit', '-qm', 'more');
  r.g('checkout', '-q', 'main'); r.g('merge', '-q', 'pr'); r.g('checkout', '-q', 'pr');
  r.write('features/billing/refund.js', 'const a = 1;\nconst b = 20;\nconst c = 3;\n');
  r.commit();
  assert.strictEqual(r.check('--labels', '').code, 0, 'the path says refund, the changed line does not');
  r.write('features/billing/refund.js', '// refund rule changed\nconst a = 1;\nconst b = 20;\nconst c = 3;\n');
  r.commit();
  assert.match(r.check('--labels', '').out, /Billing: money/);
  r.write('features/billing/refund.js', 'const a = 1;\nconst b = 20;\nconst c = 3;\n');
  r.commit();
  r.g('checkout', '-q', 'main'); r.g('merge', '-q', 'pr'); r.g('checkout', '-q', 'pr');
  r.write('features/billing/refund.js', '// refund\nconst a = 1;\nconst b = 20;\nconst c = 3;\n');
  r.commit();
  r.g('checkout', '-q', 'main'); r.g('merge', '-q', 'pr'); r.g('checkout', '-q', 'pr');
  r.write('features/billing/refund.js', '// refund\nconst a = 10;\nconst b = 20;\nconst c = 3;\n');
  r.commit();
  assert.strictEqual(r.check('--labels', '').code, 0, 'a removed or added pattern line is what counts, not the line beside it');
  r.g('checkout', '-q', 'main'); r.g('merge', '-q', 'pr'); r.g('checkout', '-q', 'pr');
  r.write('features/billing/refund.js', 'const a = 10;\nconst b = 20;\nconst c = 3;\n');
  r.commit();
  assert.match(r.check('--labels', '').out, /Billing: money/, 'deleting a line that matches counts too');
});

test('a label accepts a weakening but never hides it', () => {
  const r = repo();
  r.editModel(m => { m.components.auth.kind = 'feature'; });
  r.commit();
  const c = r.check('--labels', 'owner-review');
  assert.strictEqual(c.code, 0, c.out);
  assert.match(c.out, /weakens the map, accepted by the owner-review label/);
  assert.match(r.map('--format', 'md'), /This PR weakens/);
});

test('without labels (a local run) the gate reports but does not fail', () => {
  const r = repo();
  r.editModel(m => { m.components.auth.kind = 'feature'; });
  r.commit();
  const c = r.check();
  assert.strictEqual(c.code, 0, c.out);
  assert.match(c.out, /a PR will need the "owner-review" label/);
});

test('labels also come from the action\'s env var', () => {
  const r = repo(); r.write('core/auth/rbac.js', 'x\n'); r.commit();
  const run = v => spawnSync('node', [CLI, 'check', '--base', 'main'], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, ARCHWHERE_PR_LABELS: v } }).status;
  assert.strictEqual(run('[]'), 1);
  assert.strictEqual(run('["owner-review"]'), 0);
});

test('an unreadable base fails closed', () => {
  const r = repo();
  const c = spawnSync('node', [CLI, 'check', '--base', 'no-such-ref'], { cwd: r.dir, encoding: 'utf8' });
  assert.strictEqual(c.status, 1);
  assert.match(c.stderr, /cannot compare with no-such-ref/);
});

test('a repo adopting the map has nothing to compare with', () => {
  const r = repo();
  r.g('checkout', '-q', '--orphan', 'empty'); r.g('rm', '-rqf', '.');
  r.write('x.txt', 'x'); r.g('add', '-A'); r.g('commit', '-qm', 'nomodel');
  r.g('checkout', '-qb', 'adopt');
  r.write('arch/architecture.json', JSON.stringify({ components: { x: { name: 'X', kind: 'ops', paths: ['**'] } } }));
  r.commit();
  const c = spawnSync('node', [CLI, 'check', '--base', 'empty', '--labels', ''], { cwd: r.dir, encoding: 'utf8' });
  assert.strictEqual(c.status, 0, c.stderr);
});

test('check names a flow step and a lane that point at a removed component', () => {
  const r = repo();
  r.editModel(m => {
    m.flows = { login: { name: 'Login', steps: [{ from: 'web', to: 'ghost', label: 'go' }] } };
    m.lanes = [['web'], ['phantom']];
  });
  r.commit();
  const c = spawnSync('node', [CLI, 'check'], { cwd: r.dir, encoding: 'utf8' });
  assert.strictEqual(c.status, 1);
  assert.match(c.stderr, /flow login: step names "ghost"/);
  assert.match(c.stderr, /lane 2: "phantom" is not a component/);
});

test('check rejects a watch pattern that is not a regex; map survives it', () => {
  const r = repo();
  r.editModel(m => { m.components.web.watch = [{ pattern: '(', note: 'x' }]; });
  r.write('web/app.js', 'y\n');
  r.commit();
  const c = spawnSync('node', [CLI, 'check'], { cwd: r.dir, encoding: 'utf8' });
  assert.strictEqual(c.status, 1);
  assert.match(c.stderr, /not a valid regex/);
  assert.match(r.map(), /not a valid regex/);
});

test('an import across components with no declared dep is a note, not a failure', () => {
  const r = repo();
  r.write('web/app.js', "const a = require('../core/auth/session');\nmodule.exports = a;\n");
  r.write('web/app.test.js', "require('../features/billing/refund');\n");
  r.editModel(m => { m.components.web.paths = ['web/**']; });
  r.commit();
  const c = spawnSync('node', [CLI, 'check'], { cwd: r.dir, encoding: 'utf8' });
  assert.strictEqual(c.status, 0, c.stderr);
  assert.match(c.stderr, /web imports auth \(1×\), but its deps don't declare it/);
  assert.doesNotMatch(c.stderr, /imports billing/);
  r.editModel(m => { m.components.web.deps = ['auth']; });
  const d = spawnSync('node', [CLI, 'check'], { cwd: r.dir, encoding: 'utf8' });
  assert.doesNotMatch(d.stderr, /web imports auth/);
});

test('map --base treats a rename as touching both components', () => {
  const r = repo();
  r.g('mv', 'core/auth/session.js', 'web/session.js');
  r.commit();
  const res = W.mapFiles(MODEL, W.changedFiles(r.dir, 'main'));
  assert.deepStrictEqual(res.byComponent.get('auth'), ['core/auth/session.js']);
  assert.deepStrictEqual(res.byComponent.get('web'), ['web/session.js']);
});

test('the template runs on label changes and turns enforcement on; the action has the input', () => {
  const t = fs.readFileSync(path.join(__dirname, '..', 'templates', 'archwhere.yml'), 'utf8');
  assert.match(t, /types: \[opened, synchronize, reopened, labeled, unlabeled\]/);
  assert.match(t, /enforce: true/);
  assert.match(t, /fetch-depth: 0/);
  const a = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');
  assert.match(a, /enforce:\n[\s\S]*?default: 'false'/, 'off by default: upgrading v1 must not start failing PRs');
  assert.match(a, /ARCHWHERE_PR_LABELS: \$\{\{ toJSON\(github\.event\.pull_request\.labels\.\*\.name\) \}\}/);
});
