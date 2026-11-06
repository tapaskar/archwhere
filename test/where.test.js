'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const W = require('../lib/where');

const EX = path.join(__dirname, '..', 'examples', 'meridian');
const arch = W.loadArch(EX);

test('example model loads and is well-formed', () => {
  assert.strictEqual(W.systemName(arch), 'Meridian');
  for (const [id, c] of Object.entries(arch.components)) {
    assert.match(id, /^[a-z0-9-]+$/);
    assert.ok(c.name && c.kind && Array.isArray(c.paths) && c.paths.length, id);
    for (const d of c.deps || []) assert.ok(arch.components[d], `${id} dep ${d}`);
  }
});

test('glob semantics: * stays within a segment, ** crosses', () => {
  assert.ok(W.globToRe('web/*.js').test('web/a.js'));
  assert.ok(!W.globToRe('web/*.js').test('web/a/b.js'));
  assert.ok(W.globToRe('web/**').test('web/a/b.js'));
  assert.ok(W.globToRe('*.md').test('README.md'));
  assert.ok(!W.globToRe('*.md').test('docs/x.md'));
});

test('most specific glob wins; unmapped reported', () => {
  const { byComponent, unmapped } = W.mapFiles(arch, [
    'core/auth/session.js', 'core/tickets/sla.js', 'web/app.js', 'README.md', 'mystery/file.x'
  ]);
  const get = f => { for (const [id, fs] of byComponent) if (fs.includes(f)) return id; };
  assert.strictEqual(get('core/auth/session.js'), 'auth');
  assert.strictEqual(get('core/tickets/sla.js'), 'ticket-engine');
  assert.strictEqual(get('web/app.js'), 'web-app');
  assert.strictEqual(get('README.md'), 'docs');
  assert.deepStrictEqual(unmapped, ['mystery/file.x']);
});

test('lanes: declared wins; fallback groups by kind', () => {
  assert.deepStrictEqual(W.lanesOf(arch)[0], ['web-app', 'mobile-api', 'admin-console']);
  const noLanes = { ...arch, lanes: undefined };
  const lanes = W.lanesOf(noLanes);
  assert.ok(lanes.flat().length === Object.keys(arch.components).length);
  assert.deepStrictEqual(W.laneTitles(arch)[1], 'CORE · SECURITY');
});

test('doc and mermaid render with flows and styles', () => {
  const doc = W.renderFullMd(arch);
  assert.ok(doc.includes('Meridian — architecture map'));
  assert.ok(doc.includes('Customer reply to resolved ticket'));
  assert.ok(doc.includes('Web app → Ticket engine'));
  const mm = W.mermaid(arch, ['auth']);
  assert.ok(mm.includes('classDef security'));
  assert.ok(mm.includes('class auth touched'));
});

test('provider renders on mermaid labels and the doc table', () => {
  const mm = W.mermaid(arch, []);
  assert.ok(mm.includes('LLM gateway<br/><i>AWS Bedrock</i>'));
  const doc = W.renderFullMd(arch);
  assert.ok(doc.includes('| Provider |'));
  assert.ok(doc.includes('Stripe'));
});

test('flowDiagram: one line per participant and step, and text cannot break out of its line', () => {
  const a = { components: { a: { name: 'Alpha' }, b: { name: 'Beta "x"' } } };
  const d = W.flowDiagram(a, { steps: [{ from: 'a', to: 'b', label: 'asks;\n%%{init}%% #1' }, { from: 'b', to: 'b', label: '' }] });
  const lines = d.split('\n');
  assert.strictEqual(lines[0], 'sequenceDiagram');
  assert.strictEqual(lines.length, 6);
  assert.ok(lines.includes('  participant p1 as Beta x'));
  assert.doesNotMatch(d, /[;#%"]/);
});

test('systemFlow: the map marks touched components, and a model without flows is fine', () => {
  const sf = W.systemFlow(arch, [Object.keys(arch.components)[0]]);
  assert.strictEqual(sf.touched, 1);
  assert.match(sf.map, /touched/);
  assert.strictEqual(sf.flows.length, Object.keys(arch.flows).length);
  for (const f of sf.flows) assert.match(f.diagram, /^sequenceDiagram/);
  assert.deepStrictEqual(W.systemFlow({ components: { a: { name: 'A', kind: 'core' } } }).flows, []);
});

test('the System flow drawer loads Mermaid pinned by hash, in strict mode, only when opened', () => {
  const html = require('fs').readFileSync(path.join(__dirname, '..', 'ui', 'mission.html'), 'utf8');
  // The flow is a drawer now, not a tab: it must still be opt-in, and still load nothing until asked.
  assert.match(html, /<details id="dflow"[^>]*>\s*<summary>System flow<\/summary>/);
  assert.match(html, /#dflow'\)\.addEventListener\('toggle'/, 'loaded on open, not at start');
  assert.match(html, /MERMAID_SRI = 'sha384-[A-Za-z0-9+\/=]+'/);
  assert.match(html, /securityLevel: 'strict'/);
  assert.doesNotMatch(html, /<script src=/, 'not loaded until the lens opens');
  assert.match(require('fs').readFileSync(path.join(__dirname, '..', 'lib', 'mission.js'), 'utf8'), /u\.pathname === '\/api\/system-flow'/);
});

// init() rewrites the tab title and the heading from the model, so a board branded only in the
// static HTML showed the user's own system name and never "archwhere". Both must survive it.
test('the board names archwhere, not only the system it is pointed at', () => {
  const html = require('fs').readFileSync(path.join(__dirname, '..', 'ui', 'mission.html'), 'utf8');

  assert.match(html, /document\.title = MODEL\.system \+ ' — archwhere mission control'/);

  // The wordmark is a sibling of #htitle: anything inside it is destroyed by the textContent write.
  const h1 = html.match(/<h1>[\s\S]*?<\/h1>/);
  assert.ok(h1, 'header h1 present');
  assert.match(h1[0], /<span id="htitle">/);
  assert.match(h1[0], /<a class="brand"[^>]*>archwhere<\/a>/);
  assert.doesNotMatch(h1[0], /<span id="htitle">[\s\S]*class="brand"[\s\S]*<\/span>/,
    'the wordmark must not sit inside #htitle');

  const sets = html.match(/\$?\(?'#htitle'\)?[^\n]*textContent\s*=\s*[^\n]*/g) || [];
  assert.strictEqual(sets.length, 1, 'exactly one place writes the heading');
  assert.doesNotMatch(sets[0], /archwhere/, 'the heading carries the system; the wordmark is static');
});

// The board was six lenses: Structure / Changes / Heat / Runtime / System flow / Record. Each was
// a different way of looking at the same map, so every question cost a tab change and the answer
// never sat beside the thing you would do about it. One surface now: rail, map, thread.
test('the board is one surface, not a stack of lenses', () => {
  const html = require('fs').readFileSync(path.join(__dirname, '..', 'ui', 'mission.html'), 'utf8');

  assert.doesNotMatch(html, /data-lens|data-l="/, 'no lens switching left');
  for (const gone of ['Structure', 'Changes', 'Runtime']) {
    assert.doesNotMatch(html, new RegExp('<button[^>]*>' + gone), gone + ' is no longer a tab');
  }

  // What replaced them: one toggle over the same cards.
  assert.match(html, /<button data-m="health"[^>]*class="on"/);
  assert.match(html, /<button data-m="heat"/);
  assert.match(html, /document\.body\.dataset\.metric = b\.dataset\.m/);

  // Badges, alerts and the metric line used to be revealed by a lens; they are always on now.
  for (const sel of ['\\.node \\.m \\{', '\\.badge \\{', '\\.alert \\{']) {
    const rule = html.match(new RegExp('^\\s*' + sel + '[^}]*\\}', 'm'));
    assert.ok(rule, sel + ' rule present');
    assert.doesNotMatch(rule[0], /display:\s*none/, sel + ' must not start hidden');
  }

  // Three zones, all visible at once.
  for (const id of ['rail', 'map', 'panel']) assert.match(html, new RegExp('id="' + id + '"'));
});
