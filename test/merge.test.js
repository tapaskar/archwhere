'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const W = require('../lib/where');
const L = require('../lib/rail');
const M = require('../lib/merge');
const { stubGithub, pull, pullRoutes } = require('./stub-github');

const EX = path.join(__dirname, '..', 'examples', 'meridian');
const arch = W.loadArch(EX);
const GREEN = [{ status: 'completed', conclusion: 'success' }];
const now = Date.parse('2026-11-04T00:00:00Z');
const daysAgo = d => new Date(now - d * 86400000).toISOString();

const ready = (over = {}) => ({
  number: 1, title: 'x', state: 'open', files: ['features/search/q.js'], labels: [], checkRuns: GREEN,
  mergeable: true, mergeable_state: 'clean', head_sha: 'aaa', created_at: daysAgo(2), updated_at: daysAgo(0), ...over,
});
const railOf = (prs, opts = {}) => L.buildRail(arch, { prs, issues: [] }, { now, ...opts });
const sectionOf = (rail, n) => Object.keys(rail).find(k => rail[k].some(i => i.number === n));
const itemOf = (rail, n) => Object.values(rail).flat().find(i => i.number === n);

// ---- checks

test('only success, neutral and skipped count as green', () => {
  for (const c of ['success', 'neutral', 'skipped']) assert.strictEqual(L.checksConclusion([{ status: 'completed', conclusion: c }]), 'success', c);
  for (const c of ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale', null, 'something-new']) {
    assert.strictEqual(L.checksConclusion([{ status: 'completed', conclusion: c }]), 'failure', String(c));
  }
});

// ---- the rail

test('a clean, recent PR is ready and says why', () => {
  const rail = railOf([ready()]);
  assert.strictEqual(sectionOf(rail, 1), 'mergeable');
  assert.deepStrictEqual(rail.mergeable[0].reasons, ['checks green', 'no conflicts']);
  assert.strictEqual(rail.mergeable[0].ageDays, 2);
});

test('a PR GitHub has not assessed yet is not called ready', () => {
  for (const mergeable of [null, undefined]) {
    const rail = railOf([ready({ mergeable })]);
    assert.strictEqual(sectionOf(rail, 1), 'attention');
    assert.match(itemOf(rail, 1).reasons.join(), /not finished working out/);
  }
});

test('each thing that stops a PR being ready is named', () => {
  const cases = [
    [{ draft: true }, /draft/],
    [{ checkRuns: [{ status: 'completed', conclusion: 'failure' }] }, /checks failing/],
    [{ checkRuns: [{ status: 'in_progress' }] }, /checks still running/],
    [{ checkRuns: [] }, /no checks reported/],
    [{ mergeable: false, mergeable_state: 'dirty' }, /merge conflict/],
    [{ mergeable_state: 'blocked' }, /branch protection/],
    [{ mergeable_state: 'behind' }, /behind its base/],
    [{ filesUnknown: true, files: [] }, /could not read all the changed files/],
    [{ updated_at: daysAgo(30) }, /no activity for 30 days/],
    [{ files: ['mystery/x.bin'] }, /1 file not on the map/],
  ];
  for (const [over, why] of cases) {
    const rail = railOf([ready(over)]);
    assert.strictEqual(sectionOf(rail, 1), 'attention', String(why));
    assert.match(itemOf(rail, 1).reasons.join(' | '), why);
  }
});

test('stale threshold is configurable', () => {
  const old = ready({ updated_at: daysAgo(5) });
  assert.strictEqual(sectionOf(railOf([old]), 1), 'mergeable');
  assert.strictEqual(sectionOf(railOf([old], { staleDays: 3 }), 1), 'attention');
});

test('two ready PRs on one file: the older stays ready, the other waits and says for what', () => {
  const rail = railOf([
    ready({ number: 7, files: ['features/search/q.js', 'features/search/r.js'] }),
    ready({ number: 3, files: ['features/search/q.js'] }),
    ready({ number: 9, files: ['features/search/z.js'] }),
  ]);
  assert.strictEqual(sectionOf(rail, 3), 'mergeable');
  assert.strictEqual(sectionOf(rail, 9), 'mergeable');
  assert.strictEqual(sectionOf(rail, 7), 'attention');
  assert.match(itemOf(rail, 7).reasons.join(), /that PR #3 also changes \(features\/search\/q\.js\)/);
});

test('a failing PR does not hold a ready one on the same file', () => {
  const rail = railOf([
    ready({ number: 2, checkRuns: [{ status: 'completed', conclusion: 'failure' }] }),
    ready({ number: 5 }),
  ]);
  assert.strictEqual(sectionOf(rail, 5), 'mergeable');
});

test('overlaps name the shared component and files', () => {
  const rail = railOf([
    ready({ number: 1, files: ['features/search/a.js'] }),
    ready({ number: 2, files: ['features/search/b.js', 'features/billing/c.js'] }),
    ready({ number: 3, files: ['web/x.js'] }),
  ]);
  assert.deepStrictEqual(itemOf(rail, 1).overlaps, [{ number: 2, components: ['search'], files: [] }]);
  assert.deepStrictEqual(itemOf(rail, 3).overlaps, []);
});

test('a PR that weakens the map, or edits CI, goes to the security section', () => {
  const weak = railOf([ready({ weakenings: [{ code: 'kind-downgraded', message: '**Auth** was reclassified' }] })]);
  assert.strictEqual(sectionOf(weak, 1), 'security');
  assert.match(itemOf(weak, 1).reasons[0], /weakens the map: Auth was reclassified/);
  assert.ok(itemOf(weak, 1).flags.includes('weakens the map'));
  const ci = railOf([ready({ files: ['.github/workflows/ci.yml'] })]);
  assert.strictEqual(sectionOf(ci, 1), 'security');
});

test('a green security PR can merge after confirmation; a failing one cannot', () => {
  const zoned = ready({ files: ['core/auth/s.js'] });
  assert.strictEqual(itemOf(railOf([zoned]), 1).canMerge, true);
  assert.strictEqual(itemOf(railOf([{ ...zoned, draft: true }]), 1).canMerge, false);
});

// ---- the decision

test('mergeDecision: ready and unchanged is allowed', () => {
  assert.deepStrictEqual(M.mergeDecision(arch, ready(), { sha: 'aaa' }), { ok: true, code: 'ok', reasons: [] });
});

test('mergeDecision: refuses a moved head, or no commit named at all', () => {
  assert.strictEqual(M.mergeDecision(arch, ready(), { sha: 'old' }).code, 'moved');
  assert.strictEqual(M.mergeDecision(arch, ready(), {}).code, 'moved');
});

test('mergeDecision: refuses what stopped being ready, closed, or was labelled blocked', () => {
  for (const over of [{ checkRuns: [{ status: 'completed', conclusion: 'failure' }] }, { mergeable: false }, { draft: true }, { mergeable: null }, { filesUnknown: true },
    { labels: [{ name: 'blocked' }] }]) {
    assert.strictEqual(M.mergeDecision(arch, ready(over), { sha: 'aaa' }).code, 'not-ready', JSON.stringify(over));
  }
  assert.match(M.mergeDecision(arch, ready({ state: 'closed' }), { sha: 'aaa' }).reasons[0], /no longer open/);
});

test('mergeDecision: stale is advice, not a refusal', () => {
  assert.strictEqual(M.mergeDecision(arch, ready({ updated_at: daysAgo(90) }), { sha: 'aaa' }).ok, true);
});

test('mergeDecision: a security PR needs its own number as confirmation', () => {
  const zoned = ready({ number: 12, files: ['core/auth/s.js'] });
  const d = M.mergeDecision(arch, zoned, { sha: 'aaa' });
  assert.strictEqual(d.code, 'confirm');
  assert.match(d.reasons[0], /security component Auth & sessions/);
  assert.strictEqual(M.mergeDecision(arch, zoned, { sha: 'aaa', confirm: 13 }).code, 'confirm');
  assert.strictEqual(M.mergeDecision(arch, zoned, { sha: 'aaa', confirm: 12 }).ok, true);
});

// ---- reading GitHub

const REPO = '/repos/acme/meridian';
const ctxFor = async routes => {
  const s = await stubGithub(routes);
  const gh = require('../lib/gh').makeGh({ base: s.url, token: '' });
  return { s, ctx: { gh, API: p => `${s.url}${REPO}${p}`, cache: new Map(), modelPath: 'arch/architecture.json', tracked: ['core/auth/s.js'] } };
};

test('prFiles reads every page, and the old name of a rename', async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({ filename: `web/f${i}.js` }));
  const { s, ctx } = await ctxFor({
    [`GET ${REPO}/pulls/1/files?per_page=100&page=1`]: first,
    [`GET ${REPO}/pulls/1/files?per_page=100&page=2`]: [{ filename: 'web/moved.js', previous_filename: 'core/auth/s.js' }],
  });
  try {
    const files = await M.prFiles(ctx.gh, ctx.API, 1);
    assert.strictEqual(files.length, 102);
    assert.ok(files.includes('core/auth/s.js'), 'file 101 of the PR, moved out of the zone');
    assert.strictEqual(sectionOf(railOf([ready({ files })]), 1), 'security');
  } finally { s.server.close(); }
});

test('prFacts folds commit statuses into checks', async () => {
  const pr = pull(1);
  const { s, ctx } = await ctxFor(pullRoutes(pr, ['web/a.js'], { statuses: [{ state: 'failure' }] }));
  try {
    const f = await M.prFacts(ctx, 1);
    assert.strictEqual(L.checksConclusion(f.checkRuns), 'failure');
    assert.strictEqual(f.mergeable, true);
    assert.strictEqual(f.head_sha, 'head1');
  } finally { s.server.close(); }
});

test('prFacts fails safe when files or checks cannot be read', async () => {
  const pr = pull(1);
  const { s, ctx } = await ctxFor({ [`GET ${REPO}/pulls/1`]: pr });
  try {
    const f = await M.prFacts(ctx, 1);
    assert.strictEqual(f.filesUnknown, true);
    assert.strictEqual(L.checksConclusion(f.checkRuns), 'failure');
    assert.strictEqual(sectionOf(railOf([{ ...f, updated_at: daysAgo(0) }]), 1), 'attention');
  } finally { s.server.close(); }
});

const b64 = o => ({ content: Buffer.from(JSON.stringify(o)).toString('base64') });

test('a PR that reclassifies a component in the model is caught from the commits, and read once', async () => {
  const base = JSON.parse(fs.readFileSync(path.join(EX, 'architecture.json'), 'utf8'));
  const head = JSON.parse(JSON.stringify(base)); head.components.auth.kind = 'feature';
  const pr = pull(4);
  const { s, ctx } = await ctxFor({
    ...pullRoutes(pr, ['arch/architecture.json']),
    [`GET ${REPO}/contents/arch/architecture.json?ref=base0`]: b64(base),
    [`GET ${REPO}/contents/arch/architecture.json?ref=head4`]: b64(head),
  });
  try {
    const f = await M.prFacts(ctx, 4);
    assert.deepStrictEqual(f.weakenings.map(w => w.code), ['kind-downgraded']);
    const before = s.calls.length;
    await M.prFacts(ctx, 4);
    const again = s.calls.slice(before).map(c => c.url.split('?')[0]);
    assert.deepStrictEqual(again, [`${REPO}/pulls/4`, `${REPO}/commits/head4/check-runs`, `${REPO}/commits/head4/status`]);
  } finally { s.server.close(); }
});

test('a model that cannot be compared is treated as a weakening', async () => {
  const pr = pull(4);
  const { s, ctx } = await ctxFor({
    ...pullRoutes(pr, ['arch/architecture.json']),
    [`GET ${REPO}/contents/arch/architecture.json?ref=base0`]: { content: Buffer.from('{not json').toString('base64') },
  });
  try {
    const f = await M.prFacts(ctx, 4);
    assert.deepStrictEqual(f.weakenings.map(w => w.code), ['model-unreadable']);
  } finally { s.server.close(); }
});

// ---- the real server

function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archwhere-mission-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q'); g('remote', 'add', 'origin', 'https://github.com/acme/meridian.git');
  fs.mkdirSync(path.join(dir, 'arch'));
  fs.copyFileSync(path.join(EX, 'architecture.json'), path.join(dir, 'arch', 'architecture.json'));
  return dir;
}

async function mission(routes) {
  const s = await stubGithub(routes);
  const prev = { api: process.env.GITHUB_API, tok: process.env.GITHUB_TOKEN };
  process.env.GITHUB_API = s.url; process.env.GITHUB_TOKEN = 'test';
  delete require.cache[require.resolve('../lib/mission')];
  const { makeServer } = require('../lib/mission');
  const m = makeServer({ root: gitRepo() });
  process.env.GITHUB_API = prev.api === undefined ? '' : prev.api;
  if (prev.api === undefined) delete process.env.GITHUB_API;
  if (prev.tok === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prev.tok;
  await new Promise(ok => m.server.listen(0, '127.0.0.1', ok));
  const port = m.server.address().port;
  const send = (method, url, body, headers = {}) => new Promise((ok, no) => {
    const raw = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { host: `localhost:${port}`, ...(raw ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
      let t = ''; res.on('data', c => { t += c; }); res.on('end', () => ok({ status: res.statusCode, body: t ? JSON.parse(t) : null }));
    });
    req.on('error', no); if (raw) req.write(raw); req.end();
  });
  return { s, send, port, close: () => { m.server.close(); s.server.close(); } };
}

const puts = s => s.calls.filter(c => c.method === 'PUT');

test('POST /api/merge rechecks live and merges pinned to the commit', async () => {
  const pr = pull(5);
  const m = await mission({ ...pullRoutes(pr, ['features/search/a.js']), [`PUT ${REPO}/pulls/5/merge`]: { merged: true } });
  try {
    const r = await m.send('POST', '/api/merge', { number: 5, sha: 'head5' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.merged, true);
    assert.deepStrictEqual(puts(m.s).map(c => c.body), [{ merge_method: 'merge', sha: 'head5' }]);
  } finally { m.close(); }
});

test('POST /api/merge refuses without touching GitHub when the head moved or checks went red', async () => {
  const moved = await mission(pullRoutes(pull(5), ['features/search/a.js']));
  try {
    const r = await moved.send('POST', '/api/merge', { number: 5, sha: 'older' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, 'moved');
    assert.strictEqual(puts(moved.s).length, 0);
  } finally { moved.close(); }
  const red = await mission(pullRoutes(pull(5), ['features/search/a.js'], { checks: [{ status: 'completed', conclusion: 'failure' }] }));
  try {
    const r = await red.send('POST', '/api/merge', { number: 5, sha: 'head5' });
    assert.strictEqual(r.status, 409);
    assert.deepStrictEqual(r.body.reasons, ['checks failing']);
    assert.strictEqual(puts(red.s).length, 0);
  } finally { red.close(); }
});

test('POST /api/merge needs the confirmation for a security PR', async () => {
  const m = await mission({ ...pullRoutes(pull(6), ['core/auth/s.js']), [`PUT ${REPO}/pulls/6/merge`]: { merged: true } });
  try {
    const no = await m.send('POST', '/api/merge', { number: 6, sha: 'head6' });
    assert.strictEqual(no.status, 409);
    assert.strictEqual(no.body.code, 'confirm');
    assert.strictEqual(puts(m.s).length, 0);
    const yes = await m.send('POST', '/api/merge', { number: 6, sha: 'head6', confirmSecurity: 6 });
    assert.strictEqual(yes.status, 200);
    assert.strictEqual(puts(m.s).length, 1);
  } finally { m.close(); }
});

test('a head that moves between the recheck and the merge is reported, not a server error', async () => {
  const m = await mission({ ...pullRoutes(pull(5), ['features/search/a.js']), [`PUT ${REPO}/pulls/5/merge`]: { __status: 409, message: 'Head branch was modified' } });
  try {
    const r = await m.send('POST', '/api/merge', { number: 5, sha: 'head5' });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /Head branch was modified/);
  } finally { m.close(); }
});

test('another website cannot drive the merge route, and a rebinding Host gets nothing', async () => {
  const m = await mission({ ...pullRoutes(pull(5), ['features/search/a.js']), [`PUT ${REPO}/pulls/5/merge`]: { merged: true } });
  try {
    const good = { number: 5, sha: 'head5' };
    const cross = await m.send('POST', '/api/merge', good, { origin: 'https://evil.example' });
    assert.strictEqual(cross.status, 403);
    const simple = await m.send('POST', '/api/merge', good, { 'content-type': 'text/plain' });
    assert.strictEqual(simple.status, 403);
    const rebound = await m.send('POST', '/api/merge', good, { host: 'evil.example' });
    assert.strictEqual(rebound.status, 403);
    assert.strictEqual((await m.send('GET', '/api/model', undefined, { host: 'evil.example:4610' })).status, 403);
    assert.strictEqual(puts(m.s).length, 0);
    const own = await m.send('POST', '/api/merge', good, { origin: `http://localhost:${m.port}` });
    assert.strictEqual(own.status, 200);
  } finally { m.close(); }
});

test('isLocalRequest', () => {
  const j = { 'content-type': 'application/json; charset=utf-8' };
  assert.ok(L.isLocalRequest('GET', { host: 'localhost:4610' }));
  assert.ok(L.isLocalRequest('GET', { host: '127.0.0.1:4610' }));
  assert.ok(L.isLocalRequest('POST', { host: 'localhost:4610', ...j }));
  assert.ok(!L.isLocalRequest('GET', {}));
  assert.ok(!L.isLocalRequest('GET', { host: 'localhost.evil.example' }));
  assert.ok(!L.isLocalRequest('POST', { host: 'localhost:4610' }));
  assert.ok(!L.isLocalRequest('POST', { host: 'localhost:4610', origin: 'http://localhost:9999', ...j }));
});

test('/api/state reads mergeability from each PR and counts what it left out', async () => {
  const list = Array.from({ length: 22 }, (_, i) => {
    const p = pull(i + 1); return { number: p.number, head: p.head, base: p.base, title: p.title, labels: [] }; // the list endpoint has no mergeable
  });
  const routes = { [`GET ${REPO}/pulls`]: list, [`GET ${REPO}/issues`]: [] };
  for (const p of list) Object.assign(routes, pullRoutes(pull(p.number, p.number === 1 ? { mergeable: false, mergeable_state: 'dirty' } : {}), [`web/f${p.number}.js`]));
  const m = await mission(routes);
  try {
    const st = (await m.send('GET', '/api/state')).body;
    assert.strictEqual(st.hiddenPrs, 2);
    const conflicted = st.rail.attention.find(i => i.number === 1);
    assert.ok(conflicted && conflicted.reasons.includes('merge conflict'), 'a conflicted PR must not read as ready');
    assert.strictEqual(st.rail.mergeable.find(i => i.number === 2).sha, 'head2');
  } finally { m.close(); }
});
