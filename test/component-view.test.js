'use strict';
const test = require('node:test');
const assert = require('node:assert');
const V = require('../lib/component-view');

const OK = { ok: true, segments: ['s1'], errors: [] };
const f = (hash, component, over = {}) => ({
  type: 'finding', hash, ts: '2026-11-06T0' + hash.slice(-1) + ':00:00Z',
  title: 'finding ' + hash, body: 'detail', components: [component],
  author: 'a', agent: 'ag', model: 'gpt-5', vendor: 'openai', ...over,
});

test('nothing derived is shown when the record does not verify', () => {
  // load() hands back entries whether or not they survived verify. A panel built on that would
  // render edited history as fact, which is worse than a panel admitting it cannot vouch.
  const bad = { ok: false, segments: ['s1'], errors: [{ kind: 'edited', detail: 'line 3' }] };
  const out = V.componentView([f('h1', 'auth')], 'auth', { verified: bad, listSpecs: () => [{ name: 's' }] });
  assert.strictEqual(out.ok, false);
  assert.deepStrictEqual(out.findings, []);
  assert.deepStrictEqual(out.specs, []);
  assert.match(out.reason, /does not verify/);
  assert.deepStrictEqual(out.problems, ['edited: line 3']);
});

test('only this component’s findings appear', () => {
  const out = V.componentView([f('h1', 'auth'), f('h2', 'billing')], 'auth', { verified: OK });
  assert.deepStrictEqual(out.findings.map(x => x.hash), ['h1']);
});

test('every entry is marked declared, never presented as proven identity', () => {
  const out = V.componentView([f('h1', 'auth')], 'auth', { verified: OK });
  const one = out.findings[0];
  assert.strictEqual(one.declared, true);
  assert.strictEqual(one.vendor, 'openai');
});

test('a corrected finding is marked and ranked below live ones, never dropped', () => {
  // The correction is the evidence; hiding the pair loses it. But a corrected finding must not
  // sit above one nobody has answered.
  const entries = [
    f('h1', 'auth'),                                  // older, will be corrected
    f('h2', 'auth'),                                  // newer, uncorrected
    { type: 'correction', hash: 'c1', corrects: 'h1', ts: '2026-11-06T05:00:00Z',
      body: 'measured again; it was the clock', author: 'b', agent: 'ag2', model: 'claude-opus-5', vendor: 'anthropic' },
  ];
  const out = V.componentView(entries, 'auth', { verified: OK });
  assert.deepStrictEqual(out.findings.map(x => x.hash), ['h2', 'h1'], 'live first');
  const corrected = out.findings.find(x => x.hash === 'h1');
  assert.strictEqual(corrected.corrected, true);
  assert.strictEqual(corrected.corrections.length, 1);
  assert.match(corrected.corrections[0].body, /the clock/);
  assert.strictEqual(corrected.corrections[0].declared, true);
});

test('uncorrected findings are newest first', () => {
  const out = V.componentView([f('h1', 'auth'), f('h3', 'auth'), f('h2', 'auth')], 'auth', { verified: OK });
  assert.deepStrictEqual(out.findings.map(x => x.hash), ['h3', 'h2', 'h1']);
});

test('the feed is capped', () => {
  const many = Array.from({ length: 40 }, (_, i) => f('x' + (i % 10), 'auth'));
  assert.strictEqual(V.componentView(many, 'auth', { verified: OK, limit: 5 }).findings.length, 5);
});

test('long text is clipped rather than shipped whole to the browser', () => {
  const long = f('h1', 'auth', { body: 'x'.repeat(5000), title: 'y'.repeat(900) });
  const one = V.componentView([long], 'auth', { verified: OK }).findings[0];
  assert.ok(one.body.length <= V.MAX_TEXT + 1, 'body clipped');
  assert.ok(one.title.length <= 301, 'title clipped');
  assert.match(one.body, /…$/);
});

test('the panel says which record it is reading, so "no spec" cannot be read as "there is none"', () => {
  const out = V.componentView([], 'auth', { verified: OK, listSpecs: () => [] });
  assert.strictEqual(out.provenance.from, "this checkout's record");
  assert.strictEqual(out.provenance.segments, 1);
  assert.match(out.provenance.note, /not here unless imported/);
  assert.strictEqual(out.specsEmpty, 'no spec in this record');
});

test('more than one segment changes what the note admits', () => {
  const out = V.componentView([], 'auth', { verified: { ok: true, segments: ['s1', 's2'], errors: [] } });
  assert.strictEqual(out.provenance.segments, 2);
  assert.match(out.provenance.note, /never imported/);
});

test('a forked spec keeps its fork marker through the view', () => {
  const specs = () => [{ name: 'sla', version: 3, sha256: 'aa', forked: ['aa', 'bb'], title: 'SLA' }];
  const out = V.componentView([], 'auth', { verified: OK, listSpecs: specs });
  assert.deepStrictEqual(out.specs[0].forked, ['aa', 'bb']);
  assert.strictEqual(out.specs[0].declared, true);
  assert.strictEqual(out.specsEmpty, null);
});

test('a correction aimed at nothing does not invent a finding', () => {
  const entries = [{ type: 'correction', hash: 'c1', corrects: 'missing', ts: '2026-11-06T01:00:00Z', body: 'x' }];
  assert.deepStrictEqual(V.componentView(entries, 'auth', { verified: OK }).findings, []);
});
