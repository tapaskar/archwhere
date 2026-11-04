'use strict';
// archwhere guard: compare a PR's model with the model it is trying to replace. The base model is the
// trusted one: a PR must not be able to escape review by editing the map in the same change. Zero dependencies.

const path = require('path');
const { execFileSync } = require('child_process');
const W = require('./where');

const REVIEW_LABEL = 'owner-review';
const MODEL_CANDIDATES = ['arch/architecture.json', 'architecture.json'];
// The files that decide whether these checks run at all, or who has to review.
const GATE_FILE = /^(\.github\/workflows\/[^/]+|(\.github\/|docs\/)?CODEOWNERS)$/;

const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const patternsOf = c => (c && Array.isArray(c.watch) ? c.watch.map(w => w && w.pattern).filter(Boolean) : []);
const isSecurity = c => !!c && c.kind === 'security';
const isZone = c => isSecurity(c) || patternsOf(c).length > 0;
const label = (c, id) => (c && c.name) || id;

function ownersOf(arch, files) {
  const owners = new Map();
  for (const [id, fs_] of W.mapFiles(arch, files).byComponent) for (const f of fs_) owners.set(f, id);
  return owners;
}

/**
 * Every way `head` reviews less than `base`: a security component removed or reclassified, a watch
 * pattern removed or edited, or a file that left its zone because a glob changed (longest match wins,
 * so another component can take a file out of a security zone without touching that zone).
 * `files` should cover both trees. Returns [{ code, component, message }].
 */
function modelWeakenings(base, head, files = []) {
  const out = [];
  const removed = new Set();
  for (const [id, c] of Object.entries(base.components)) {
    if (!isZone(c)) continue;
    const h = own(head.components, id);
    if (!h) {
      removed.add(id);
      out.push({ code: 'zone-removed', component: id, message: `**${label(c, id)}** (${c.kind}) was removed from the model` });
      continue;
    }
    if (isSecurity(c) && !isSecurity(h)) {
      out.push({ code: 'kind-downgraded', component: id, message: `**${label(c, id)}** was reclassified from security to ${h.kind || 'no kind'}` });
    }
    const keep = patternsOf(h);
    for (const p of patternsOf(c)) {
      if (!keep.includes(p)) out.push({ code: 'watch-removed', component: id, message: `**${label(c, id)}** lost its watch pattern \`${p}\`` });
    }
  }
  const baseOwners = ownersOf(base, files), headOwners = ownersOf(head, files);
  const moved = new Map();
  for (const f of files) {
    const from = baseOwners.get(f), to = headOwners.get(f);
    if (!from || from === to || removed.has(from)) continue;
    const bc = base.components[from], hc = to ? own(head.components, to) : null;
    if (!isZone(bc)) continue;
    const loses = (isSecurity(bc) && !isSecurity(hc)) || patternsOf(bc).some(p => !patternsOf(hc).includes(p));
    if (!loses) continue;
    const k = from + '>' + (to || '');
    if (!moved.has(k)) moved.set(k, { from, to, files: [] });
    moved.get(k).files.push(f);
  }
  for (const { from, to, files: fs_ } of moved.values()) {
    const where = to ? `to **${label(own(head.components, to), to)}**` : 'off the map';
    const shown = fs_.slice(0, 5).map(f => '`' + f + '`').join(', ') + (fs_.length > 5 ? ', …' : '');
    out.push({ code: 'zone-narrowed', component: from, message: `${fs_.length} file${fs_.length === 1 ? '' : 's'} left **${label(base.components[from], from)}** ${where}: ${shown}` });
  }
  return out;
}

function quiet(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}
const lines = s => s.split('\n').filter(Boolean);

/** The model as it was at `ref`: { arch, rel }, or null when that commit has none. */
function modelAtRef(root, ref, explicit) {
  const wanted = [explicit, process.env.ARCHWHERE_MODEL].filter(Boolean)
    .map(p => path.relative(root, path.resolve(root, p)).split(path.sep).join('/'))
    .filter(p => !p.startsWith('..'));
  for (const rel of [...wanted, ...MODEL_CANDIDATES]) {
    let text;
    try { text = quiet(root, ['show', `${ref}:${rel}`]); } catch { continue; }
    const arch = JSON.parse(text);
    if (!arch.components || typeof arch.components !== 'object') throw new Error(`${rel} at ${ref} has no "components"`);
    return { arch, rel };
  }
  return null;
}

/**
 * Compare this checkout with `base`. Flags come from both models, so reclassifying a component in the
 * PR that changes it still raises the flag. Throws if `base` can't be read: callers must fail closed.
 */
function runGuard(root, base, explicit) {
  const head = W.loadArch(root, explicit);
  let mergeBase;
  try { mergeBase = quiet(root, ['merge-base', base, 'HEAD']).trim(); }
  catch { throw new Error(`cannot find a merge base with ${base} (the checkout needs fetch-depth: 0)`); }
  const changed = W.changedFiles(root, mergeBase);
  const was = modelAtRef(root, mergeBase, explicit);
  const headRel = path.relative(root, head.__path).split(path.sep).join('/');
  const weakenings = [];
  if (was) {
    if (was.rel !== headRel) weakenings.push({ code: 'model-moved', component: null, message: `the model moved from \`${was.rel}\` to \`${headRel}\`` });
    const files = [...new Set([...lines(quiet(root, ['ls-tree', '-r', '--name-only', mergeBase])), ...lines(quiet(root, ['ls-files']))])];
    weakenings.push(...modelWeakenings(was.arch, head, files));
  }
  const models = was ? [was.arch, head] : [head];
  const flags = [...new Set(models.flatMap(m => W.collectFlags(m, root, mergeBase, W.mapFiles(m, changed).byComponent)))];
  const gateFiles = changed.filter(f => GATE_FILE.test(f));
  return { base, mergeBase, adopting: !was, changed, weakenings, flags, gateFiles, needsReview: !!(weakenings.length || flags.length || gateFiles.length) };
}

/** Parse --labels "a,b" or ARCHWHERE_PR_LABELS (JSON array or comma list). null = not known here. */
function parseLabels(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (s.startsWith('[')) { try { return JSON.parse(s).map(String); } catch { /* fall through */ } }
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

/** Why a PR still needs the review label. `labels` null means a local run, which only reports. */
function gateFailures(g, labels) {
  if (!g.needsReview || (labels && labels.includes(REVIEW_LABEL))) return [];
  const plain = s => s.replace(/\*\*/g, '').replace(/`/g, '');
  return [
    ...g.weakenings.map(w => `weakens the map: ${plain(w.message)}`),
    ...g.flags.map(plain),
    ...g.gateFiles.map(f => `edits ${f}, which controls these checks`),
  ];
}

module.exports = { REVIEW_LABEL, GATE_FILE, modelWeakenings, modelAtRef, runGuard, parseLabels, gateFailures };
