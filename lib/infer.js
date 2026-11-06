'use strict';
// archwhere infer: draft a first architecture model from the repository itself —
// directory structure, package.json workspaces, and import edges. The draft is a
// starting point for a human (or their coding agent) to correct, never the truth.
// Zero dependencies.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const W = require('./where');

const CODE_EXT = /\.(js|mjs|cjs|jsx|ts|tsx)$/;
const MAX_IMPORT_FILES = 3000;
const MAX_FILE_BYTES = 200 * 1024;
const IMPORT_SUFFIXES = ['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '/index.js', '/index.ts'];

/** Kind guessed from a directory (or workspace) name. */
function guessKind(name) {
  const n = name.toLowerCase().replace(/^@[^/]+\//, '');
  if (/^(auth|security|iam|acl|crypto|secrets?)$/.test(n)) return 'security';
  if (/^(ui|web|webapp|frontend|client|www|pages|views|components|site|app)$/.test(n)) return 'product';
  if (/^(infra|terraform|deploy|deployment|docker|k8s|kubernetes|helm|db|database|migrations?)$/.test(n)) return 'infra';
  if (/^(\.github|ci|scripts?|tools?|ops|build|config|bin)$/.test(n)) return 'ops';
  if (/^(docs?|documentation|examples?|samples?)$/.test(n)) return 'docs';
  if (/^(tests?|__tests__|spec|e2e)$/.test(n)) return 'ops';
  if (/^(src|lib|server|api|core|engine|common|shared|internal|pkg|packages|services)$/.test(n)) return 'core';
  return 'feature';
}

function idOf(name) {
  const id = name.toLowerCase().replace(/^@[^/]+\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return id || 'component';
}

function titleOf(name) {
  const base = name.replace(/^@[^/]+\//, '');
  return base.charAt(0).toUpperCase() + base.slice(1).replace(/[-_]/g, ' ');
}

function trackedFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const files = out.split('\n').filter(Boolean);
    if (files.length) return files;
  } catch { /* not a git repo */ }
  // fs walk fallback
  const files = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'vendor']);
  (function walk(dir) {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(path.posix.join(dir, e.name)); }
      else files.push(path.posix.join(dir, e.name));
    }
  })('');
  return files.map(f => f.replace(/^\//, ''));
}

/** package.json workspaces → concrete workspace dirs that exist in the file list. */
function workspaceDirs(root, files) {
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { return []; }
  const globs = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces && pkg.workspaces.packages) || [];
  const dirs = new Set();
  for (const g of globs) {
    const re = W.globToRe(g.replace(/\/$/, '') + '/package.json');
    for (const f of files) if (re.test(f)) dirs.add(path.posix.dirname(f));
  }
  return [...dirs].sort();
}

/** Decide the directory units that become components. */
function pickUnits(root, files) {
  const units = []; // { dir, name } ; dir '' never appears — root files go to the repo component
  const ws = workspaceDirs(root, files);
  const covered = [];
  for (const d of ws) {
    let name = path.posix.basename(d);
    try { name = JSON.parse(fs.readFileSync(path.join(root, d, 'package.json'), 'utf8')).name || name; } catch { /* keep */ }
    units.push({ dir: d, name });
    covered.push(d + '/');
  }
  // top-level dirs not covered by a workspace
  const top = new Map(); // dir -> count
  for (const f of files) {
    if (covered.some(c => f.startsWith(c))) continue;
    const i = f.indexOf('/');
    if (i === -1) continue;
    const d = f.slice(0, i);
    top.set(d, (top.get(d) || 0) + 1);
  }
  for (const [d] of [...top.entries()].sort((a, b) => b[1] - a[1])) {
    // split big container dirs (src, packages, services, apps) by their subdirs
    const sub = new Map();
    let loose = 0;
    for (const f of files) {
      if (!f.startsWith(d + '/')) continue;
      const rest = f.slice(d.length + 1);
      const j = rest.indexOf('/');
      if (j === -1) loose++;
      else sub.set(rest.slice(0, j), (sub.get(rest.slice(0, j)) || 0) + 1);
    }
    const container = /^(src|packages|apps|services|modules)$/.test(d);
    if (container && sub.size >= 2 && sub.size <= 24) {
      for (const [s] of sub) units.push({ dir: `${d}/${s}`, name: s, parent: d });
      if (loose) units.push({ dir: d, name: d, looseOnly: true });
    } else {
      units.push({ dir: d, name: d });
    }
  }
  return units;
}

/** Import edges between units, from relative require()/import paths in JS/TS files. */
function importDeps(root, files, unitOf) {
  const edges = new Map(); // 'a>b' -> count
  let read = 0;
  for (const f of files) {
    if (!CODE_EXT.test(f) || read >= MAX_IMPORT_FILES) continue;
    const from = unitOf(f);
    if (!from) continue;
    let text;
    try {
      const st = fs.statSync(path.join(root, f));
      if (st.size > MAX_FILE_BYTES) continue;
      text = fs.readFileSync(path.join(root, f), 'utf8'); read++;
    } catch { continue; }
    const re = /require\(\s*['"]([^'"]+)['"]\s*\)|from\s+['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(text))) {
      const spec = m[1] || m[2];
      if (!spec || !spec.startsWith('.')) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec));
      const to = unitOf(resolved) || IMPORT_SUFFIXES.map(x => unitOf(resolved + x)).find(Boolean);
      if (to && to !== from) {
        const k = from + '>' + to;
        edges.set(k, (edges.get(k) || 0) + 1);
      }
    }
  }
  return edges;
}

/**
 * Infer a draft architecture model for root. Returns { model, stats }.
 * The model always passes `archwhere check`: every tracked file maps and
 * every component matches at least one file.
 */
function inferModel(root, opts = {}) {
  const files = trackedFiles(root);
  if (!files.length) throw new Error('nothing to infer from: no tracked files found');
  const units = pickUnits(root, files);

  const components = {};
  const dirToId = new Map();
  const used = new Set();
  const uniq = id => { let x = id, n = 2; while (used.has(x)) x = `${id}-${n++}`; used.add(x); return x; };

  for (const u of units) {
    const id = uniq(idOf(u.name));
    dirToId.set(u.dir, id);
    const count = files.filter(f => u.looseOnly
      ? f.startsWith(u.dir + '/') && !f.slice(u.dir.length + 1).includes('/')
      : f.startsWith(u.dir + '/')).length;
    if (!count) { used.delete(id); dirToId.delete(u.dir); continue; }
    components[id] = {
      name: titleOf(u.name),
      kind: guessKind(u.name),
      description: `INFERRED — everything under ${u.dir}/ (${count} file${count === 1 ? '' : 's'}). Refine me.`,
      paths: [u.looseOnly ? `${u.dir}/*` : `${u.dir}/**`],
      deps: []
    };
  }

  // repo component for root-level files and anything else unmapped
  const draft = { components };
  let { unmapped } = W.mapFiles(draft, files);
  if (unmapped.length) {
    const paths = new Set();
    for (const f of unmapped) paths.add(f.includes('/') ? f.slice(0, f.indexOf('/')) + '/**' : '*');
    const id = uniq('repo');
    components[id] = {
      name: 'Repo & tooling', kind: 'ops',
      description: `INFERRED — root files and anything not owned by another component (${unmapped.length} files).`,
      paths: [...paths].sort(), deps: []
    };
  }

  // longest-prefix unit lookup for import edges
  const dirs = [...dirToId.keys()].sort((a, b) => b.length - a.length);
  const unitOf = f => { for (const d of dirs) if (f === d || f.startsWith(d + '/')) return dirToId.get(d); return null; };
  const edges = importDeps(root, files, unitOf);
  const byFrom = new Map();
  for (const [k, n] of edges) {
    const [a, b] = k.split('>');
    if (!byFrom.has(a)) byFrom.set(a, []);
    byFrom.get(a).push({ to: b, n });
  }
  for (const [a, list] of byFrom) {
    if (!components[a]) continue;
    components[a].deps = list.sort((x, y) => y.n - x.n).slice(0, 4).map(x => x.to).filter(b => components[b]);
  }

  let system = path.basename(root);
  try { system = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name || system; } catch { /* dir name */ }

  const model = {
    system,
    note: 'INFERRED by `archwhere init --infer` — a draft, not the truth. Rename components, fix kinds, add descriptions/providers/watch patterns and 2-3 flows, then delete this note.',
    components,
    flows: {}
  };
  return {
    model,
    stats: { files: files.length, components: Object.keys(components).length, deps: [...edges.keys()].length }
  };
}

/**
 * Relative JS/TS imports between components that `deps` doesn't declare: [{ from, to, count }].
 * Tests, scripts and docs are left out, since they reach into everything. The opposite direction isn't
 * reported: a declared dep can be HTTP or a queue, which imports don't show.
 */
function undeclaredDeps(root, arch, files) {
  const memo = new Map();
  const owner = f => {
    if (!memo.has(f)) memo.set(f, [...W.mapFiles(arch, [f]).byComponent.keys()][0] || null);
    return memo.get(f);
  };
  const quietKind = id => ['ops', 'docs'].includes((arch.components[id] || {}).kind);
  const src = files.filter(f => !/\.(test|spec)\.[a-z]+$/.test(f));
  const out = [];
  for (const [k, count] of importDeps(root, src, owner)) {
    const [from, to] = k.split('>');
    if (quietKind(from) || quietKind(to) || (arch.components[from].deps || []).includes(to)) continue;
    out.push({ from, to, count });
  }
  return out.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

module.exports = { undeclaredDeps, inferModel, guessKind, pickUnits, workspaceDirs, trackedFiles };
