'use strict';
// archwhere core: load a declared architecture model, map changed files to
// components, render text / markdown / mermaid / html. Zero dependencies.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** Locate the model: explicit/env wins, then arch/architecture.json, then ./architecture.json. */
function findModelPath(root, explicit) {
  const cands = [
    explicit, process.env.ARCHWHERE_MODEL,
    path.join(root, 'arch', 'architecture.json'),
    path.join(root, 'architecture.json')
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

function loadArch(root, explicit) {
  const p = findModelPath(root, explicit);
  if (!p) throw new Error('no architecture model found (arch/architecture.json). Run: archwhere init');
  const arch = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!arch.components || typeof arch.components !== 'object') {
    throw new Error(p + ': missing "components"');
  }
  arch.__path = p;
  return arch;
}

const systemName = arch => arch.system || 'System';

const KIND_ORDER = ['product', 'core', 'security', 'feature', 'infra', 'ops', 'docs'];

/** Lanes: declared, else grouped by kind in a stable order. */
function lanesOf(arch) {
  if (Array.isArray(arch.lanes) && arch.lanes.length) return arch.lanes;
  const byKind = {};
  for (const [id, c] of Object.entries(arch.components)) (byKind[c.kind] = byKind[c.kind] || []).push(id);
  const order = [...KIND_ORDER, ...Object.keys(byKind).filter(k => !KIND_ORDER.includes(k))];
  return order.map(k => byKind[k]).filter(Boolean);
}

function laneTitles(arch) {
  const lanes = lanesOf(arch);
  if (Array.isArray(arch.laneTitles) && arch.laneTitles.length === lanes.length) return arch.laneTitles;
  return lanes.map(lane => {
    const kinds = [...new Set(lane.map(id => (arch.components[id] || {}).kind).filter(Boolean))];
    return kinds.join(' · ').toUpperCase();
  });
}

// ** crosses directories, * stays within one path segment.
function globToRe(glob) {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '.*');
  return new RegExp('^' + esc + '$');
}

function compileMatchers(arch) {
  const out = [];
  for (const [id, c] of Object.entries(arch.components)) {
    for (const g of c.paths || []) out.push({ id, glob: g, re: globToRe(g), len: g.length });
  }
  return out;
}

/** Longest matching glob wins, so a specific component beats a broad one. */
function mapFiles(arch, files) {
  const matchers = compileMatchers(arch);
  const byComponent = new Map();
  const unmapped = [];
  for (const f of files) {
    let best = null;
    for (const m of matchers) if (m.re.test(f) && (!best || m.len > best.len)) best = m;
    if (!best) { unmapped.push(f); continue; }
    if (!byComponent.has(best.id)) byComponent.set(best.id, []);
    byComponent.get(best.id).push(f);
  }
  return { byComponent, unmapped };
}

const staticPrefix = g => { const i = g.search(/[*?[]/); return (i === -1 ? g : g.slice(0, i)).replace(/\/[^/]*$/, ''); };
const segs = p => p ? p.split('/') : [];

/**
 * For unmapped files, suggest model fixes: which existing component should adopt
 * them (longest shared directory prefix with its globs), or a new component when
 * nothing is close. Returns { additions: {componentId: [globs]}, fresh: [{id, glob, files}] }.
 */
function suggestPatch(arch, unmapped) {
  const groups = new Map(); // dir -> files
  for (const f of unmapped) {
    const d = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(f);
  }
  const additions = {}; const fresh = [];
  const add = (id, glob) => { (additions[id] = additions[id] || []).push(glob); };
  for (const [dir, files] of groups) {
    let best = null;
    for (const [id, c] of Object.entries(arch.components)) {
      for (const g of c.paths || []) {
        const a = segs(dir), b = segs(staticPrefix(g));
        let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++;
        if (n > 0 && (!best || n > best.n)) best = { id, n };
      }
    }
    const glob = dir ? (files.length > 1 ? dir + '/**' : files[0]) : (files.length > 2 ? '*' : files.join('|'));
    if (best) {
      if (dir) add(best.id, glob);
      else for (const f of files) add(best.id, f);
    } else if (dir) {
      const top = dir.split('/')[0];
      const id = top.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'new-component';
      const ex = fresh.find(x => x.id === id);
      if (ex) ex.files.push(...files);
      else fresh.push({ id, glob: top + '/**', files: [...files] });
    } else {
      // root files with no near component: a repo/ops bucket
      const ex = fresh.find(x => x.id === 'repo');
      if (ex) ex.files.push(...files);
      else fresh.push({ id: 'repo', glob: '*', files: [...files] });
    }
  }
  for (const id of Object.keys(additions)) additions[id] = [...new Set(additions[id])];
  return { additions, fresh };
}

/** Human-readable patch lines for a suggestPatch result. */
function patchLines(arch, patch) {
  const out = [];
  for (const [id, globs] of Object.entries(patch.additions)) {
    out.push(`components.${id}.paths += ${globs.map(g => JSON.stringify(g)).join(', ')}`);
  }
  for (const f of patch.fresh) {
    out.push(`new component "${f.id}" with paths ["${f.glob}"] (${f.files.length} file${f.files.length === 1 ? '' : 's'})`);
  }
  return out;
}

/** Apply a suggestPatch result to the model file on disk. Returns a summary line. */
function applyPatch(arch, patch) {
  const raw = JSON.parse(require('fs').readFileSync(arch.__path, 'utf8'));
  let changed = 0;
  for (const [id, globs] of Object.entries(patch.additions)) {
    if (!raw.components[id]) continue;
    raw.components[id].paths = [...new Set([...(raw.components[id].paths || []), ...globs])];
    changed++;
  }
  for (const f of patch.fresh) {
    if (raw.components[f.id]) { raw.components[f.id].paths = [...new Set([...(raw.components[f.id].paths || []), f.glob])]; }
    else {
      raw.components[f.id] = {
        name: f.id.charAt(0).toUpperCase() + f.id.slice(1).replace(/-/g, ' '),
        kind: 'feature',
        description: 'ADDED by archwhere check --fix — set the real kind and description.',
        paths: [f.glob], deps: []
      };
    }
    changed++;
  }
  require('fs').writeFileSync(arch.__path, JSON.stringify(raw, null, 2) + '\n');
  return `patched ${arch.__path}: ${changed} component${changed === 1 ? '' : 's'} updated`;
}

/**
 * Change heat per component over the last N days of git history.
 * Returns { days, max, components: {id: {changes, files}} } or null when git history is unavailable.
 */
function changeHeat(root, arch, days = 30) {
  let out = '';
  try { out = git(root, ['log', `--since=${days}.days`, '--name-only', '--pretty=format:']); }
  catch { return null; }
  const perFile = new Map();
  for (const l of out.split('\n')) if (l.trim()) perFile.set(l.trim(), (perFile.get(l.trim()) || 0) + 1);
  const { byComponent } = mapFiles(arch, [...perFile.keys()]);
  const components = {};
  let max = 0;
  for (const [id, files] of byComponent) {
    const changes = files.reduce((s, f) => s + perFile.get(f), 0);
    components[id] = { changes, files: files.length };
    if (changes > max) max = changes;
  }
  return { days, max, components };
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function changedFiles(root, base) {
  const set = new Set();
  const add = out => out.split('\n').forEach(f => { if (f) set.add(f); });
  if (base) {
    // --no-renames: moving a file out of a component touches that component too.
    add(git(root, ['diff', '--name-only', '--no-renames', base + '...HEAD']));
  } else {
    add(git(root, ['diff', '--name-only', '--no-renames', 'HEAD']));
    add(git(root, ['ls-files', '-o', '--exclude-standard']));
  }
  return [...set].sort();
}

function diffText(root, base, files) {
  try {
    return base
      ? git(root, ['diff', base + '...HEAD', '--', ...files])
      : git(root, ['diff', 'HEAD', '--', ...files]);
  } catch { return ''; }
}

/** Security components always flag; watch patterns run against the diff text. */
function collectFlags(arch, root, base, byComponent) {
  const flags = [];
  for (const [id, files] of byComponent) {
    const c = arch.components[id];
    if (c.kind === 'security') {
      flags.push(`**${c.name}** is a security component — review accordingly.`);
    }
    if (c.watch && c.watch.length) {
      const text = diffText(root, base, files);
      for (const w of c.watch) {
        let re;
        try { re = new RegExp(w.pattern, 'i'); }
        catch { flags.push(`**${c.name}**: watch pattern \`${w.pattern}\` is not a valid regex`); continue; }
        if (re.test(text)) flags.push(`**${c.name}**: ${w.note}`);
      }
    }
  }
  return flags;
}

const KIND_STYLE = {
  core: 'fill:#E8EEF9,stroke:#2F4AC0,color:#1F2433',
  security: 'fill:#FDE8E4,stroke:#C2410C,color:#1F2433',
  feature: 'fill:#FFF4E0,stroke:#B45309,color:#1F2433',
  infra: 'fill:#EFEFEF,stroke:#595959,color:#1F2433',
  product: 'fill:#E3F2EC,stroke:#0F7A5C,color:#1F2433',
  ops: 'fill:#F3E8F9,stroke:#7E3FA0,color:#1F2433',
  docs: 'fill:#F7F7F7,stroke:#8A8A8A,color:#1F2433',
  other: 'fill:#F2F2EF,stroke:#777,color:#1F2433'
};

function mermaid(arch, touchedIds) {
  const touched = new Set(touchedIds || []);
  const L = ['flowchart LR'];
  for (const [id, c] of Object.entries(arch.components)) {
    const label = c.provider ? `${c.name}<br/><i>${c.provider}</i>` : c.name;
    L.push(`  ${id}["${label}"]`);
  }
  for (const [id, c] of Object.entries(arch.components)) {
    for (const d of c.deps || []) if (arch.components[d]) L.push(`  ${id} --> ${d}`);
  }
  for (const [k, style] of Object.entries(KIND_STYLE)) L.push(`  classDef ${k} ${style}`);
  L.push('  classDef touched fill:#F7B32B,stroke:#1F2433,stroke-width:3px,color:#1F2433');
  const byKind = {};
  for (const [id, c] of Object.entries(arch.components)) {
    if (touched.has(id)) continue;
    const k = KIND_STYLE[c.kind] ? c.kind : 'other';
    (byKind[k] = byKind[k] || []).push(id);
  }
  for (const [kind, ids] of Object.entries(byKind)) L.push(`  class ${ids.join(',')} ${kind}`);
  if (touched.size) L.push(`  class ${[...touched].join(',')} touched`);
  return L.join('\n');
}

/** Text that is safe inside a Mermaid sequence diagram: it can't end the line or start a directive. */
function flowLabel(x) {
  return String(x == null ? '' : x).replace(/[\r\n]+/g, ' ').replace(/[;#%"<>{}]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** One process flow as a Mermaid sequence diagram. */
function flowDiagram(arch, flow) {
  const components = arch.components || {};
  const ids = [];
  for (const st of flow.steps || []) for (const id of [st.from, st.to]) if (!ids.includes(id)) ids.push(id);
  const alias = id => `p${ids.indexOf(id)}`;
  return ['sequenceDiagram', '  autonumber',
    ...ids.map(id => `  participant ${alias(id)} as ${flowLabel((components[id] || { name: id }).name)}`),
    ...(flow.steps || []).map(st => `  ${alias(st.from)}->>${alias(st.to)}: ${flowLabel(st.label) || ' '}`),
  ].join('\n');
}

/** The system map, with touched components marked, and every flow as a diagram. */
function systemFlow(arch, touchedIds) {
  const touched = touchedIds || [];
  return {
    map: mermaid(arch, touched), touched: touched.length,
    flows: Object.entries(arch.flows || {}).map(([id, f]) => ({ id, name: f.name || id, actor: f.actor || '', diagram: flowDiagram(arch, f) })),
  };
}

function renderText(arch, res, flags) {
  const out = [];
  if (!res.byComponent.size && !res.unmapped.length) return 'No changes detected.';
  for (const [id, files] of res.byComponent) {
    const c = arch.components[id];
    out.push(`${c.name}  [${c.kind}]  — ${files.length} file${files.length === 1 ? '' : 's'}`);
    for (const f of files) out.push(`    ${f}`);
  }
  for (const f of flags) out.push(`! ${f.replace(/\*\*/g, '')}`);
  if (res.unmapped.length) out.push(`? unmapped (add to the model): ${res.unmapped.join(', ')}`);
  return out.join('\n');
}

function renderMd(arch, res, flags, guard) {
  const out = ['<!-- archwhere -->', '### 🗺 Architecture impact', ''];
  const weak = (guard && guard.weakenings) || [];
  if (weak.length) {
    out.push('> [!CAUTION]', '> **This PR weakens the architecture map.** It should not merge without the owner reviewing these changes:');
    for (const w of weak) out.push('> - ' + w.message);
    out.push('');
  }
  if (!res.byComponent.size && !res.unmapped.length) {
    out.push('_No file changes detected._');
    return out.join('\n');
  }
  out.push('| Component | Kind | Files changed |', '|---|---|---|');
  for (const [id, files] of res.byComponent) {
    const c = arch.components[id];
    out.push(`| **${c.name}** | ${c.kind} | ${files.map(f => '`' + f + '`').join('<br>')} |`);
  }
  if (flags.length) { out.push('', '**Flags**', ''); for (const f of flags) out.push(`- ⚠ ${f}`); }
  for (const f of (guard && guard.gateFiles) || []) {
    out.push('', `- ⚠ edits \`${f}\`, which controls whether these checks run: review it as a security change`);
  }
  if (res.unmapped.length) {
    out.push('', `**Unmapped files** — add them to a component in the model: ${res.unmapped.map(f => '`' + f + '`').join(', ')}`);
    const lines = patchLines(arch, suggestPatch(arch, res.unmapped));
    if (lines.length) {
      out.push('', 'Suggested model patch (`arch/architecture.json`) — or run `archwhere check --fix`:', '');
      for (const l of lines) out.push('- `' + l + '`');
    }
  }
  out.push('', '<details><summary>System map — touched components highlighted</summary>', '',
    '```mermaid', mermaid(arch, [...res.byComponent.keys()]), '```', '', '</details>');
  return out.join('\n');
}

function renderFullMd(arch) {
  const out = [
    `# ${systemName(arch)} — architecture map`, '',
    '_Generated by [archwhere](https://github.com/tapaskar/archwhere) from the declared model. Do not edit by hand._', '',
    '```mermaid', mermaid(arch, []), '```', '',
    '| Component | Kind | Provider | What it is | Owns |', '|---|---|---|---|---|'
  ];
  for (const c of Object.values(arch.components)) {
    out.push(`| **${c.name}** | ${c.kind} | ${c.provider || ''} | ${c.description || ''} | ${(c.paths || []).map(p => '`' + p + '`').join(' ')} |`);
  }
  const flows = Object.entries(arch.flows || {});
  if (flows.length) {
    out.push('', '## Process flows (dynamic views)', '', '| Flow | Actor | Path |', '|---|---|---|');
    for (const [, f] of flows) {
      const seq = [];
      for (const st of f.steps) {
        if (seq[seq.length - 1] !== st.from) seq.push(st.from);
        seq.push(st.to);
      }
      const names = seq.map(id => (arch.components[id] || { name: id }).name);
      out.push(`| **${f.name}** | ${f.actor || ''} | ${names.join(' → ')} |`);
    }
  }
  out.push('');
  return out.join('\n');
}


function escHtml(x) {
  return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const KIND_COLORS = {
  core: '#2F4AC0', security: '#C2410C', feature: '#B45309', infra: '#595959',
  product: '#0F7A5C', ops: '#7E3FA0', docs: '#8A8A8A'
};

/** Self-contained one-off page: diagram + touched-component cards. */
function renderHtml(arch, res, flags, meta) {
  const touched = [...res.byComponent.keys()];
  const mode = meta && meta.base ? `branch vs ${escHtml(meta.base)}` : 'working tree';
  const cards = touched.map(id => {
    const c = arch.components[id];
    const color = KIND_COLORS[c.kind] || '#595959';
    const files = res.byComponent.get(id).map(f => `<li><code>${escHtml(f)}</code></li>`).join('');
    const prov = c.provider ? ` <span style="color:#6b7180;font-weight:400">· ${escHtml(c.provider)}</span>` : '';
    return `<div class="card" style="border-left:6px solid ${color}"><div class="ch"><b>${escHtml(c.name)}${prov}</b><span class="kind" style="background:${color}">${escHtml(c.kind)}</span></div><p>${escHtml(c.description || '')}</p><ul>${files}</ul></div>`;
  }).join('');
  const flagHtml = flags.length ? `<div class="flags"><b>⚠ Flags</b><ul>${flags.map(f => `<li>${escHtml(f.replace(/\*\*/g, ''))}</li>`).join('')}</ul></div>` : '';
  const unmapped = res.unmapped.length ? `<div class="unmapped">Unmapped: ${res.unmapped.map(f => `<code>${escHtml(f)}</code>`).join(' ')}</div>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escHtml(systemName(arch))} — architecture map</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#F7F7F5;color:#1F2433}header{padding:18px 26px;background:#1F2433;color:#FFF7EE;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}header h1{font-size:19px;margin:0}header p{margin:0;color:#C0BCBA;font-size:13px}main{display:flex;gap:18px;padding:18px 26px;align-items:flex-start;flex-wrap:wrap}#map{flex:2;min-width:460px;background:#fff;border:1px solid #DDD;border-radius:10px;padding:12px;overflow:auto}#side{flex:1;min-width:300px;display:flex;flex-direction:column;gap:12px}.card{background:#fff;border:1px solid #DDD;border-radius:10px;padding:13px 15px}.ch{display:flex;justify-content:space-between;gap:10px}.kind{color:#fff;font-size:12px;padding:2px 10px;border-radius:10px;height:fit-content}.card p{color:#595959;font-size:13px;margin:6px 0}ul{margin:4px 0 0;padding-left:18px;font-size:13px}code{background:#F1F1EE;padding:1px 5px;border-radius:4px}.flags{background:#FDE8E4;border:1px solid #C2410C;border-radius:10px;padding:11px 15px;font-size:14px}.unmapped{background:#FFF4E0;border:1px solid #B45309;border-radius:10px;padding:11px 15px;font-size:13px}</style></head>
<body><header><h1>${escHtml(systemName(arch))} — architecture map</h1><p>${mode}</p></header>
<main><div id="map"><pre class="mermaid">\n${mermaid(arch, touched)}\n</pre></div><div id="side">${flagHtml}${cards}${unmapped}</div></main>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>
<script>mermaid.initialize({ startOnLoad: true, theme: 'neutral', flowchart: { useMaxWidth: true } });</script>
</body></html>`;
}

module.exports = {
  findModelPath, loadArch, renderHtml, systemName, lanesOf, laneTitles, globToRe, mapFiles,
  changedFiles, collectFlags, mermaid, renderText, renderMd, renderFullMd, KIND_STYLE,
  suggestPatch, patchLines, applyPatch, changeHeat, flowDiagram, systemFlow
};
