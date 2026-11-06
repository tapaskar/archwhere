'use strict';
// archwhere mission control: the architecture map as a conversation surface.
// Reads GitHub; writes only when the operator acts (new thread, comment, merge).
// Zero dependencies. See README "Mission control".

const fs = require('fs');
const path = require('path');
const http = require('http');
const W = require('./where');
const L = require('./rail');
const G = require('./gh');
const SIG = require('./signals');
const I = require('./infer');

/** Read-only summary for the Record lens: never writes, works with no GitHub, and copes with no record yet. */
function recordView(root) {
  const R = require('./record'); const C = require('./claims'); const S = require('./signoff');
  const dir = R.resolveDir(root);
  const trust = S.loadSigners(root);
  const verified = R.verify(dir, { signers: trust.signers, anchors: R.tagAnchors(root) });
  const { entries } = R.load(dir);
  const offs = verified.signoffs;
  const latest = entries.slice(-50).reverse().map(e => ({
    hash: e.hash, ts: e.ts, type: e.type, title: e.title || e.name || e.question || '', task: e.task, components: e.components || [],
    author: e.author, agent: e.agent, model: e.model, vendor: e.vendor, ...S.whoMade(e, offs),
  }));
  return {
    ok: verified.ok, count: verified.count, digest: verified.digest, witness: verified.witness, anchors: verified.anchors_checked,
    problems: verified.errors.slice(0, 20).map(e => `${e.kind}: ${e.detail}`), warnings: verified.warnings.slice(0, 20),
    claims: C.foldClaims(entries).active, latest,
  };
}
const M = require('./merge');

function makeServer(opts = {}) {
  const ROOT = opts.root || process.cwd();
  const GH = G.apiBase();

  const arch0 = W.loadArch(ROOT, opts.arch);
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(arch0.__path), 'mission.config.json'), 'utf8')); } catch { /* defaults */ }
  const AGENTS = L.resolveAgents(process.env, cfg);
  const KNOWN = AGENTS.map(a => a.mention);
  const MENTION = KNOWN[0] || ''; // the default agent (kept for older UIs)
  const summon = (body, ask, suffix) => L.withSummon(body, L.selectMentions(AGENTS, ask), suffix, KNOWN);

  const TOKEN = G.githubToken();
  const { owner, repo } = G.originRepo(ROOT, L.parseRepo);
  const API = p => `${GH}/repos/${owner}/${repo}${p}`;

  const gh = G.makeGh({ base: GH, token: TOKEN });

  let viewer = null;
  async function whoami() {
    if (viewer !== null) return viewer;
    try { viewer = (await gh(`${GH}/user`)).login; } catch { viewer = ''; }
    return viewer;
  }

  const MAX_PRS = 20;
  const prCache = new Map();
  function prContext(arch) {
    const rel = path.relative(ROOT, arch.__path).split(path.sep).join('/');
    // Was an inline execFileSync, which this file never required: the ReferenceError went
    // straight into the catch below, so `tracked` was always empty even in a git checkout, and
    // the weakening check in merge.js saw only the PR's own files. infer.trackedFiles already
    // does this, and falls back to a filesystem walk outside git.
    let tracked = [];
    try { tracked = I.trackedFiles(ROOT); } catch { /* neither git nor a readable tree */ }
    return { gh, API, cache: prCache, modelPath: rel.startsWith('..') ? '' : rel, tracked };
  }

  let cache = { at: 0, data: null };
  let heatCache = { at: 0, days: 0, data: null };
  async function assembleState() {
    const arch = W.loadArch(ROOT, opts.arch);
    const [prsRaw, issuesRaw] = await Promise.all([
      gh(API('/pulls?state=open&per_page=50')),
      gh(API('/issues?state=open&per_page=100'))
    ]);
    const issues = issuesRaw.filter(i => !i.pull_request);
    const prs = await Promise.all(prsRaw.slice(0, MAX_PRS).map(p => M.prFacts(prContext(arch), p.number, p)));
    const rail = L.buildRail(arch, { prs, issues }, { staleDays: cfg.staleDays });
    const badges = L.componentBadges(arch, { prs, issues }, rail);
    let local = { components: [], unmapped: [] };
    try {
      const res = W.mapFiles(arch, W.changedFiles(ROOT, null));
      local = { components: [...res.byComponent.keys()], unmapped: res.unmapped };
    } catch { /* not a git checkout */ }
    return {
      generated: new Date().toISOString(), repo: `${owner}/${repo}`, rail, badges, local,
      hiddenPrs: Math.max(0, prsRaw.length - MAX_PRS),
      prs: prs.map(p => ({ ...p, components: L.prComponents(arch, p) })),
      threads: issues
        .map(i => ({
          number: i.number, title: i.title, comments: i.comments, url: i.html_url,
          components: (i.labels || []).map(l => L.componentFromLabel(l.name)).filter(Boolean),
          labels: (i.labels || []).map(l => l.name)
        }))
        .filter(t => t.components.length || t.labels.some(l => ['security', 'blocked', 'needs-owner'].includes(l)))
    };
  }
  async function state() {
    if (Date.now() - cache.at < 20000 && cache.data) return cache.data;
    cache = { at: Date.now(), data: await assembleState() };
    return cache.data;
  }

  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type + '; charset=utf-8' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  const readBody = req => new Promise((ok, no) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 1e6) no(new Error('body too large')); });
    req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } });
  });
  async function ensureLabel(nameL) {
    try {
      await gh(API('/labels'), { method: 'POST', body: JSON.stringify({ name: nameL, color: '0F7A5C', description: 'archwhere component thread' }) });
    } catch (e) { if (!String(e.message).includes('422')) throw e; }
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (!L.isLocalRequest(req.method, req.headers)) return send(res, 403, { error: 'mission control only answers its own page on localhost' });
    try {
      if (req.method === 'GET' && u.pathname === '/') {
        return send(res, 200, fs.readFileSync(path.join(__dirname, '..', 'ui', 'mission.html'), 'utf8'), 'text/html');
      }
      if (req.method === 'GET' && u.pathname === '/api/model') {
        const arch = W.loadArch(ROOT, opts.arch);
        return send(res, 200, {
          system: W.systemName(arch), components: arch.components,
          lanes: W.lanesOf(arch), laneTitles: W.laneTitles(arch), flows: arch.flows || {},
          repo: `${owner}/${repo}`, viewer: await whoami(), mention: MENTION, agents: AGENTS
        });
      }
      if (req.method === 'GET' && u.pathname === '/api/state') return send(res, 200, await state());
      if (req.method === 'GET' && u.pathname === '/api/system-flow') {
        const arch = W.loadArch(ROOT, opts.arch);
        // Still draws if GitHub is unreachable, just without the open PRs marked.
        const prs = await state().then(st => st.prs).catch(() => []);
        return send(res, 200, W.systemFlow(arch, L.touchedComponents(arch, prs)));
      }
      if (req.method === 'GET' && u.pathname === '/api/thread') {
        const n = parseInt(u.searchParams.get('number'), 10);
        const [issue, comments] = await Promise.all([
          gh(API(`/issues/${n}`)), gh(API(`/issues/${n}/comments?per_page=100`))
        ]);
        return send(res, 200, {
          number: n, title: issue.title, state: issue.state, url: issue.html_url,
          body: issue.body || '', user: issue.user && issue.user.login,
          comments: comments.map(c => {
            const m = { user: c.user.login, userType: c.user.type, at: c.created_at, body: c.body };
            return { ...m, agent: L.replyAgent(m, AGENTS) };
          })
        });
      }
      if (req.method === 'POST' && u.pathname === '/api/thread') {
        const { component, title, body, ask } = await readBody(req);
        const arch = W.loadArch(ROOT, opts.arch);
        if (!arch.components[component]) return send(res, 400, { error: 'unknown component' });
        const label = L.threadLabel(component);
        await ensureLabel(label);
        const fullBody = summon(body, ask,
          ' please investigate and reply in this thread. Component: `' + component + '` (see the architecture model).');
        const issue = await gh(API('/issues'), {
          method: 'POST', body: JSON.stringify({ title: `[${component}] ${title}`, body: fullBody, labels: [label] })
        });
        cache.at = 0;
        return send(res, 200, { number: issue.number, url: issue.html_url });
      }
      if (req.method === 'POST' && u.pathname === '/api/comment') {
        const { number, body, ask } = await readBody(req);
        await gh(API(`/issues/${number}/comments`), { method: 'POST', body: JSON.stringify({ body: summon(body, ask) }) });
        cache.at = 0;
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && u.pathname === '/api/merge') {
        const { number, sha, confirmSecurity } = await readBody(req);
        const arch = W.loadArch(ROOT, opts.arch);
        const r = await M.mergeWithRecheck(prContext(arch), arch, { number, sha, confirm: confirmSecurity });
        cache.at = 0;
        return send(res, r.status, r.body);
      }
      if (req.method === 'GET' && u.pathname === '/api/record') return send(res, 200, recordView(ROOT));
      if (req.method === 'GET' && u.pathname === '/api/heat') {
        const days = Math.min(parseInt(u.searchParams.get('days'), 10) || 30, 365);
        if (heatCache.data && heatCache.days === days && Date.now() - heatCache.at < 60000) {
          return send(res, 200, heatCache.data);
        }
        const arch = W.loadArch(ROOT, opts.arch);
        const heat = W.changeHeat(ROOT, arch, days);
        const data = heat || { days, max: 0, components: {}, error: 'no git history' };
        heatCache = { at: Date.now(), days, data };
        return send(res, 200, data);
      }
      if (req.method === 'GET' && u.pathname === '/api/runtime') {
        const base = process.env.RUNTIME_URL || process.env.OBS_URL;
        if (!base) return send(res, 200, { available: false, reason: 'RUNTIME_URL not set' });
        const headers = {};
        const basic = process.env.RUNTIME_BASIC || process.env.OBS_BASIC;
        if (basic) headers.Authorization = 'Basic ' + Buffer.from(basic).toString('base64');
        try {
          const r = await fetch(base, { headers });
          if (!r.ok) throw new Error('runtime endpoint ' + r.status);
          // Grade here, not in the browser: the rule belongs in one tested place, and an
          // endpoint's own status is advice, not a verdict. An unreadable payload is refused
          // rather than rendered as an empty, healthy-looking map.
          const norm = SIG.normalize(await r.json());
          if (!norm.ok) return send(res, 200, { available: false, reason: norm.reason });
          return send(res, 200, {
            available: true, stale: norm.stale, ageMs: norm.ageMs,
            components: norm.components, attention: SIG.attention(norm),
          });
        } catch (e) { return send(res, 200, { available: false, reason: String(e.message) }); }
      }
      send(res, 404, { error: 'not found' });
    } catch (e) { send(res, 500, { error: String(e.message || e) }); }
  });
  return { server, owner, repo, token: !!TOKEN };
}

module.exports = { makeServer, recordView };
