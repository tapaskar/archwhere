#!/usr/bin/env node
'use strict';
// archwhere — put your AI coding agents' work on the architecture map.
// https://github.com/tapaskar/archwhere  (MIT)

const fs = require('fs');
const path = require('path');
const W = require('../lib/where');
const Guard = require('../lib/guard');

const USAGE = `
archwhere — which architecture component does this change touch?

  archwhere [map] [--base REF] [--format text|md|mermaid|html]   map a diff
  archwhere doc  [--out ARCHITECTURE.md]                         full map doc
  archwhere check [--fix]                                        model sanity (CI-friendly); --fix adopts unmapped files
  archwhere collide --refs a,b,c [--base main] [--json]              which branches in flight will fight each other
  archwhere check --base REF [--labels a,b]                      also compare with REF: a weakened map, or security changes
                                                                 without the owner-review label, fail (labels: env ARCHWHERE_PR_LABELS)
  archwhere heat [--days 30]                                     change heat per component from git history
  archwhere ir   [--out arch/build]                              Archify IR diagrams
  archwhere mission [--port 4610]                                mission-control UI
  archwhere bridge --mention @kiro --cmd "kiro-cli chat --no-interactive" [--cwd DIR]
                 [--repo o/r] [--name Kiro] [--allow a,b] [--interval 30] [--timeout 300]
                 [--state FILE] [--once]                         let a local CLI agent answer board threads
  archwhere init [--starter]                                     draft the model from your repo + write workflows; --starter copies the example model instead
  archwhere record <command>                                     the shared attributed record: specs, decisions, findings, sign-offs (record help)
  archwhere task <command>                                       claim, renew, release and check tasks (task help)
  archwhere mcp [--write --author A --agent B --model M --vendor V] [--root DIR] [--repo o/r] [--record-dir DIR]
                                                                 MCP server on stdio; read-only unless --write

Common: --arch <path to architecture.json> · env ARCHWHERE_MODEL
Mission env: GITHUB_TOKEN (or gh auth token) · AGENT_MENTIONS="Claude=@claude,Kiro=@kiro" (or AGENT_MENTION) · RUNTIME_URL/RUNTIME_BASIC
`;

function arg(args, flag) { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; }

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] && !args[0].startsWith('-') ? args.shift() : 'map';
  const root = process.cwd();
  const archPath = arg(args, '--arch');

  if (cmd === 'record' || cmd === 'task') return require('../lib/record-cli').main(cmd, root, args);
  if (cmd === 'mcp' && !args.includes('-h') && !args.includes('--help')) return require('../lib/mcp').cli(root, args);

  if (cmd === 'help' || args.includes('-h') || args.includes('--help')) {
    process.stdout.write(USAGE); return;
  }

  if (cmd === 'init') return init(root, !args.includes('--starter'));

  if (cmd === 'mission') {
    const { makeServer } = require('../lib/mission');
    const port = parseInt(arg(args, '--port') || process.env.ARCHWHERE_PORT || '4610', 10);
    let made;
    try { made = makeServer({ root, arch: archPath }); }
    catch (e) { console.error(e.message); process.exit(2); }
    const { server, owner, repo, token } = made;
    server.listen(port, '127.0.0.1', () => {
      console.log(`archwhere mission control: http://localhost:${port}   repo ${owner}/${repo}${token ? '' : '   (no GitHub token found)'}`);
    });
    return;
  }

  if (cmd === 'bridge') return bridge(root, args);

  const arch = W.loadArch(root, archPath);

  if (cmd === 'doc') {
    const doc = W.renderFullMd(arch);
    const out = arg(args, '--out');
    if (out) { fs.writeFileSync(out, doc); console.log('wrote', out); }
    else process.stdout.write(doc);
    return;
  }

  if (cmd === 'check') {
    const { execFileSync } = require('child_process');
    const errors = [];
    const kinds = new Set(arch.kinds || ['core', 'security', 'feature', 'infra', 'product', 'ops', 'docs']);
    let tracked = [];
    try { tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean); } catch {}
    for (const [id, c] of Object.entries(arch.components)) {
      if (!/^[a-z0-9-]+$/.test(id)) errors.push(`${id}: id must be kebab-case`);
      if (!c.name) errors.push(`${id}: missing name`);
      if (!kinds.has(c.kind)) errors.push(`${id}: unknown kind "${c.kind}"`);
      if (!Array.isArray(c.paths) || !c.paths.length) errors.push(`${id}: needs path globs`);
      for (const d of c.deps || []) if (!arch.components[d]) errors.push(`${id}: dep "${d}" does not exist`);
      if (tracked.length && c.paths && !tracked.some(f => c.paths.some(g => W.globToRe(g).test(f)))) {
        errors.push(`${id}: no tracked file matches its globs — stale map`);
      }
    }
    if (tracked.length) {
      const { unmapped } = W.mapFiles(arch, tracked);
      if (unmapped.length) errors.push(`unmapped tracked files (${unmapped.length}): ${unmapped.slice(0, 10).join(', ')}${unmapped.length > 10 ? ', …' : ''}`);
    }
    for (const [fid, f] of Object.entries(arch.flows || {})) {
      for (const s of f.steps || []) {
        for (const end of [s.from, s.to]) if (!arch.components[end]) errors.push(`flow ${fid}: step names "${end}", which is not a component`);
        if (!s.label) errors.push(`flow ${fid}: step needs a label`);
      }
    }
    for (const [i, lane] of (Array.isArray(arch.lanes) ? arch.lanes : []).entries()) {
      for (const id of lane) if (!arch.components[id]) errors.push(`lane ${i + 1}: "${id}" is not a component`);
    }
    for (const [id, c] of Object.entries(arch.components)) {
      for (const w of Array.isArray(c.watch) ? c.watch : []) {
        try { new RegExp(w.pattern, 'i'); } catch { errors.push(`${id}: watch pattern "${w.pattern}" is not a valid regex`); }
      }
    }
    const notes = [];
    if (tracked.length) {
      const { undeclaredDeps } = require('../lib/infer');
      for (const d of undeclaredDeps(root, arch, tracked)) {
        notes.push(`${d.from} imports ${d.to} (${d.count}×), but its deps don't declare it`);
      }
    }
    const base = arg(args, '--base');
    if (base) {
      try {
        const g = Guard.runGuard(root, base, archPath);
        const labelArg = arg(args, '--labels');
        const labels = Guard.parseLabels(labelArg !== null ? labelArg : process.env.ARCHWHERE_PR_LABELS);
        const failures = Guard.gateFailures(g, labels);
        const need = `add the "${Guard.REVIEW_LABEL}" label once the owner has looked`;
        if (labels) for (const f of failures) errors.push(`${f} — ${need}`);
        else for (const f of failures) notes.push(`${f} — a PR will need the "${Guard.REVIEW_LABEL}" label`);
        if (!failures.length) for (const w of g.weakenings) notes.push(`weakens the map, accepted by the ${Guard.REVIEW_LABEL} label: ${w.message.replace(/\*\*|\`/g, '')}`);
      } catch (e) { errors.push(`cannot compare with ${base}: ${e.message}`); }
    }
    for (const n of notes) console.error('! ' + n);
    if (errors.length) {
      for (const e of errors) console.error('✗ ' + e);
      if (tracked.length) {
        const { unmapped } = W.mapFiles(arch, tracked);
        if (unmapped.length) {
          const patch = W.suggestPatch(arch, unmapped);
          if (args.includes('--fix')) {
            console.error('\n' + W.applyPatch(arch, patch));
            console.error('re-run `archwhere check` to confirm, then review the adopted globs.');
          } else {
            console.error('\nsuggested fixes (apply with `archwhere check --fix`):');
            for (const l of W.patchLines(arch, patch)) console.error('  + ' + l);
          }
        }
      }
      process.exit(1);
    }
    console.log(`✓ model ok: ${Object.keys(arch.components).length} components, ${Object.keys(arch.flows || {}).length} flows, every tracked file mapped`);
    return;
  }

  if (cmd === 'collide') {
    const CO = require('../lib/collide');
    const base = arg(args, '--base') || 'main';
    const refs = (arg(args, '--refs') || '').split(',').map(r => r.trim()).filter(Boolean);
    if (!refs.length) {
      console.error('collide needs --refs a,b,c (branch names), optionally --base main');
      process.exit(2);
    }
    let m;
    try { m = CO.matrix(root, arch, refs, { base }); }
    catch (e) { console.error(e.message); process.exit(2); }
    if (args.includes('--json')) { console.log(JSON.stringify(m, null, 2)); return; }

    const short = r => r.replace(/^(origin|refs\/heads)\//, '');
    console.log('against ' + base + ':');
    for (const v of m.vsBase) {
      console.log('  ' + (v.clean ? '\u2713 ' : '\u2717 ') + short(v.ref)
        + (v.clean ? ' clean' : '  conflicts in ' + (v.components.join(', ') || v.files.join(', '))));
    }
    if (m.stale.length) {
      console.log('\n' + m.stale.map(short).join(', ') + ' ' + (m.stale.length > 1 ? 'are' : 'is')
        + ' behind ' + base + '. Rebase first: until then they appear to collide with every'
        + '\ncurrent branch, which says nothing about those branches.');
    }
    const real = m.pairs.filter(p => p.overlap.length);
    console.log('\nagainst each other:' + (real.length ? '' : ' no branch changes a file another one changes'));
    for (const p of real) {
      console.log('  \u2717 ' + short(p.a) + '  \u00d7  ' + short(p.b)
        + (p.clean ? '  (same files, merges cleanly for now)' : ''));
      if (p.overlapComponents.length) console.log('      components: ' + p.overlapComponents.join(', '));
      console.log('      both change: ' + p.overlap.join(', '));
    }
    console.log('\nmerge order (least entangled first):');
    for (const o of m.order) {
      console.log('  ' + short(o.ref) + (o.collides ? '  (collides with ' + o.collides + ')' : '  (collides with nothing)'));
    }
    if (real.length || m.stale.length) process.exit(1);
    return;
  }

  if (cmd === 'heat') {
    const days = parseInt(arg(args, '--days') || '30', 10);
    const heat = W.changeHeat(root, arch, days);
    if (!heat) { console.error('no git history available'); process.exit(1); }
    const rows = Object.entries(heat.components).sort((a, b) => b[1].changes - a[1].changes);
    if (!rows.length) { console.log(`no changes in the last ${days} days`); return; }
    console.log(`change heat, last ${days} days  (changes × files)\n`);
    for (const [id, h] of rows) {
      const c = arch.components[id];
      const bar = '█'.repeat(Math.max(1, Math.round(24 * h.changes / heat.max)));
      console.log(`  ${(c ? c.name : id).padEnd(26)} ${String(h.changes).padStart(4)} × ${String(h.files).padStart(3)}  ${bar}`);
    }
    return;
  }

  if (cmd === 'ir') {
    const { emit } = require('../lib/archify');
    const outDir = arg(args, '--out') || path.join(path.dirname(arch.__path), 'build');
    for (const p of emit(arch, outDir)) console.log('wrote', path.relative(root, p));
    console.log('\nRender with Archify (https://github.com/tt-a1i/archify):');
    console.log('  node <archify>/archify/bin/archify.mjs deliver architecture <file> <out.html> --quality showcase --open');
    return;
  }

  // default: map
  const base = arg(args, '--base');
  const format = arg(args, '--format') || 'text';
  if (args.includes('--full')) {
    process.stdout.write(format === 'mermaid' ? W.mermaid(arch, []) + '\n' : W.renderFullMd(arch));
    return;
  }
  const res = W.mapFiles(arch, W.changedFiles(root, base));
  // With a base, flags come from both models: editing the map can't hide this very change.
  let guard = null;
  if (base) { try { guard = Guard.runGuard(root, base, archPath); } catch { /* no merge base: head model only */ } }
  const flags = guard ? guard.flags : W.collectFlags(arch, root, base, res.byComponent);
  const loud = guard ? guard.weakenings.map(w => 'weakens the map: ' + w.message) : [];
  if (format === 'mermaid') process.stdout.write(W.mermaid(arch, [...res.byComponent.keys()]) + '\n');
  else if (format === 'md') process.stdout.write(W.renderMd(arch, res, flags, guard) + '\n');
  else if (format === 'html') process.stdout.write(W.renderHtml(arch, res, [...loud, ...flags], { base }) + '\n');
  else process.stdout.write(W.renderText(arch, res, [...loud, ...flags]) + '\n');
}

function bridge(root, args) {
  const B = require('../lib/bridge');
  const G = require('../lib/gh');
  const { parseRepo } = require('../lib/rail');
  const a = B.parseBridgeArgs(args);
  if (!a.mention || !a.cmd) { console.error('bridge needs --mention @name and --cmd "<agent command>"\n' + USAGE); process.exit(2); }
  if (args.includes('--trust-all-tools') || /(^|\s)(-a|--trust-all-tools)(\s|$)/.test(a.cmd)) {
    console.error('refusing: the bridge must not run an agent with all tools trusted. Use a read-only agent/tool list.');
    process.exit(2);
  }
  const cwd = path.resolve(a.cwd || root);
  let owner, repo;
  if (a.repo) [owner, repo] = a.repo.split('/');
  else {
    try { ({ owner, repo } = G.originRepo(cwd, parseRepo)); }
    catch (e) { console.error(e.message); process.exit(2); }
  }
  if (!owner || !repo) { console.error('--repo must look like owner/name'); process.exit(2); }
  const token = G.githubToken();
  if (!token) { console.error('no GitHub token: set GITHUB_TOKEN or run `gh auth login`'); process.exit(2); }
  const b = B.makeBridge({
    gh: G.makeGh({ token }), owner, repo, mention: a.mention, name: a.name, cmd: a.cmd, cwd,
    allow: a.allow, intervalSec: a.interval, timeoutMs: a.timeout * 1000, statePath: a.state
  });
  console.log(`archwhere bridge: ${owner}/${repo}  ${b.mention} -> ${b.name}  cwd ${cwd}  allow ${b.allow.join(',')}  state ${b.statePath}`);
  if (a.once) {
    b.runOnce().then(r => { console.log(`done: ${r.length} job(s)`); })
      .catch(e => { console.error('bridge failed: ' + e.message); process.exit(1); });
    return;
  }
  b.start();
}

function init(root, infer) {
  const dir = path.join(root, 'arch');
  fs.mkdirSync(dir, { recursive: true });
  const modelPath = path.join(dir, 'architecture.json');
  if (fs.existsSync(modelPath)) { console.log('arch/architecture.json already exists — not touching it.'); }
  else if (infer) {
    try {
      const { inferModel } = require('../lib/infer');
      const { model, stats } = inferModel(root);
      // init is about to write these — the model must own its own scaffolding
      const scaffold = ['arch/architecture.json', '.github/workflows/archwhere.yml'];
      const miss = W.mapFiles(model, scaffold).unmapped;
      if (miss.length) {
        const bucket = model.components.repo || model.components.ops
          || (model.components.repo = { name: 'Repo & tooling', kind: 'ops', description: 'Root files, CI and the architecture model itself.', paths: [], deps: [] });
        for (const f of miss) bucket.paths.push(f.startsWith('.github/') ? '.github/**' : 'arch/**');
        bucket.paths = [...new Set(bucket.paths)];
      }
      fs.writeFileSync(modelPath, JSON.stringify(model, null, 2) + '\n');
      console.log(`wrote arch/architecture.json — inferred ${stats.components} components from ${stats.files} files (${stats.deps} import edges)`);
      console.log('it is a draft: rename, fix kinds, add flows. `archwhere check` already passes.');
    } catch (e) {
      console.log(`could not infer a model (${e.message}) — falling back to the starter example.`);
      return init(root, false);
    }
  } else {
    const starter = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'meridian', 'architecture.json'), 'utf8'));
    starter.system = path.basename(root);
    starter.note = 'STARTER MODEL — replace the example components with your real ones. ' + starter.note;
    fs.writeFileSync(modelPath, JSON.stringify(starter, null, 2) + '\n');
    console.log('wrote arch/architecture.json (starter — replace the example components; `archwhere check` fails until you do)');
  }
  const wfDir = path.join(root, '.github', 'workflows');
  fs.mkdirSync(wfDir, { recursive: true });
  for (const t of ['archwhere.yml', 'agent-reply.yml', 'agent-webhook.yml']) {
    const dest = path.join(wfDir, t);
    if (fs.existsSync(dest)) { console.log(`.github/workflows/${t} exists — skipped`); continue; }
    fs.copyFileSync(path.join(__dirname, '..', 'templates', t), dest);
    console.log('wrote .github/workflows/' + t);
  }
  console.log(`
Next — let your coding agent write the real model. Paste this to it:

  Survey this repository and refine arch/architecture.json into the real
  model: 10–20 declared components (not an import graph), each with
  name, kind (core/security/feature/infra/product/ops/docs), description,
  the file globs it owns, deps, and watch patterns for review-sensitive code.
  Add 2–3 "flows" for the main user journeys. Every tracked file must map to
  a component ("npx archwhere check" must pass). Then run
  "npx archwhere doc --out ARCHITECTURE.md" and commit both.
`);
}

main();
