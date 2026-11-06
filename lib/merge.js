'use strict';
// archwhere merge: what mission control reads about a PR, and the live recheck before it merges one.
// GitHub is asked again at the moment of the click: the rail may be minutes old. Zero dependencies.

const L = require('./rail');
const Guard = require('./guard');

const MAX_FILE_PAGES = 30;  // GitHub stops listing a PR's files at 3000
const MAX_CHECK_PAGES = 5;

/** Every file a PR touches, including the old path of a rename: moving a file out of a zone touches that zone. */
async function prFiles(gh, API, number) {
  const names = new Set();
  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const batch = await gh(API(`/pulls/${number}/files?per_page=100&page=${page}`));
    for (const f of batch) {
      names.add(f.filename);
      if (f.previous_filename) names.add(f.previous_filename);
    }
    if (batch.length < 100) return [...names];
  }
  throw new Error('too many files to read them all');
}

/** Check runs and commit statuses, in one shape. A check that can't be read is reported as failing. */
async function prChecks(gh, API, sha) {
  const runs = [];
  for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
    const r = await gh(API(`/commits/${sha}/check-runs?per_page=100&page=${page}`));
    runs.push(...(r.check_runs || []).map(x => ({ status: x.status, conclusion: x.conclusion })));
    if ((r.check_runs || []).length < 100) break;
  }
  const combined = await gh(API(`/commits/${sha}/status`));
  for (const s of combined.statuses || []) {
    if (s.state === 'pending') runs.push({ status: 'in_progress', conclusion: null });
    else runs.push({ status: 'completed', conclusion: s.state === 'success' ? 'success' : 'failure' });
  }
  return runs;
}

/** The model in a commit: parsed, or null when that commit has no such file. */
async function modelAt(gh, API, modelPath, sha) {
  let f;
  try { f = await gh(API(`/contents/${modelPath.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`)); }
  catch (e) { if (String(e.message).includes('GitHub 404')) return null; throw e; }
  return JSON.parse(Buffer.from(f.content, 'base64').toString('utf8'));
}

/** A PR that edits the model is compared with its base. If that can't be read, assume the worst. */
async function prWeakenings(ctx, p, files) {
  const { gh, API, modelPath, tracked } = ctx;
  if (!modelPath || !files.includes(modelPath)) return [];
  try {
    const base = await modelAt(gh, API, modelPath, p.base.sha);
    if (!base || !base.components) return [];
    const head = await modelAt(gh, API, modelPath, p.head.sha);
    if (!head) return [{ code: 'model-removed', component: null, message: 'the model file was removed' }];
    if (!head.components) return [{ code: 'model-invalid', component: null, message: 'the model has no components' }];
    return Guard.modelWeakenings(base, head, [...new Set([...(tracked || []), ...files])]);
  } catch (e) {
    return [{ code: 'model-unreadable', component: null, message: 'edits the model, and it could not be compared: ' + e.message }];
  }
}

/** What a commit changes never varies, so read it once. A read that failed is not remembered. */
async function immutableFacts(ctx, p) {
  const key = `${p.head.sha}:${p.base.sha}`;
  const hit = ctx.cache && ctx.cache.get(key);
  if (hit) return hit;
  let files;
  try { files = await prFiles(ctx.gh, ctx.API, p.number); }
  catch { return { files: [], filesUnknown: true, weakenings: [] }; }
  const facts = { files, filesUnknown: false, weakenings: await prWeakenings(ctx, p, files) };
  if (ctx.cache) {
    if (ctx.cache.size > 200) ctx.cache.clear();
    ctx.cache.set(key, facts);
  }
  return facts;
}

/**
 * One PR as the rail and the recheck see it. Only the single-PR endpoint says whether a PR conflicts:
 * the list endpoint leaves those fields out. `listed` is the fallback when that read fails.
 */
async function prFacts(ctx, number, listed) {
  const { gh, API } = ctx;
  const p = await gh(API(`/pulls/${number}`)).catch(e => { if (listed) return listed; throw e; });
  const fixed = await immutableFacts(ctx, p);
  const checkRuns = await prChecks(gh, API, p.head.sha).catch(() => [{ status: 'completed', conclusion: 'unreadable' }]);
  return {
    number: p.number, title: p.title, labels: p.labels, draft: p.draft, state: p.state, merged: !!p.merged,
    html_url: p.html_url, comments: p.comments, review_comments: p.review_comments,
    mergeable: p.mergeable, mergeable_state: p.mergeable_state,
    branch: p.head.ref, head_sha: p.head.sha, base_sha: p.base.sha,
    created_at: p.created_at, updated_at: p.updated_at,
    ...fixed, checkRuns,
  };
}

/**
 * May this click merge this PR? { ok, code, reasons }.
 * code: 'moved' (head changed since it was shown), 'not-ready', or 'confirm' (security zone, not confirmed).
 */
function mergeDecision(arch, pr, { sha, confirm } = {}) {
  if (pr.merged || pr.state === 'closed') return { ok: false, code: 'not-ready', reasons: ['this PR is no longer open'] };
  if (!sha || sha !== pr.head_sha) {
    return { ok: false, code: 'moved', reasons: ['new commits arrived since this PR was shown: look at them first'] };
  }
  const a = L.assessPr(arch, pr);
  if (a.problems.length) return { ok: false, code: 'not-ready', reasons: a.problems };
  if (a.securityReasons.length && Number(confirm) !== Number(pr.number)) {
    return { ok: false, code: 'confirm', reasons: a.securityReasons };
  }
  return { ok: true, code: 'ok', reasons: [] };
}

/** Recheck live, then merge, pinned to the checked commit: GitHub refuses if the head moves in between. */
async function mergeWithRecheck(ctx, arch, { number, sha, confirm }) {
  const n = parseInt(number, 10);
  if (!n) return { status: 400, body: { error: 'a PR number is required', code: 'not-ready', reasons: [] } };
  const pr = await prFacts(ctx, n);
  const d = mergeDecision(arch, pr, { sha, confirm });
  if (!d.ok) return { status: 409, body: { error: d.reasons.join('; '), code: d.code, reasons: d.reasons } };
  try {
    const r = await ctx.gh(ctx.API(`/pulls/${n}/merge`), { method: 'PUT', body: JSON.stringify({ merge_method: 'merge', sha }) });
    return { status: 200, body: { merged: !!r.merged, message: r.message || '' } };
  } catch (e) {
    return { status: 409, body: { error: String(e.message), code: 'not-ready', reasons: [String(e.message)] } };
  }
}

module.exports = { prFiles, prChecks, prFacts, mergeDecision, mergeWithRecheck };
