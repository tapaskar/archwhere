'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/signals');

const T0 = Date.parse('2026-11-06T10:00:00Z');
const at = (payload, over = {}) => S.normalize(payload, { now: T0, ...over });
const one = (c, over = {}) => at({ generated: '2026-11-06T09:59:30Z', components: { x: c } }, over).components.x;

test('an error count without a denominator is not a rate', () => {
  assert.strictEqual(S.errorRate({ value: 212 }), null);
  assert.strictEqual(S.errorRate({ value: 212, of: 0 }), null);
  assert.strictEqual(S.errorRate({ value: 212, of: 'lots' }), null);
  assert.strictEqual(S.errorRate(null), null);
  assert.strictEqual(S.errorRate({ value: 212, of: 1840 }), 212 / 1840);
});

test('the same count grades differently against different traffic', () => {
  const errs = of => ({ signals: { errors: { value: 212, of } } });
  assert.strictEqual(S.grade(errs(300)), 'bad');          // 71 %
  assert.strictEqual(S.grade(errs(2000000)), 'ok');       // 0.01 %
});

test('an ungraded count never invents a verdict', () => {
  // No denominator and no stated status: the board must say it does not know.
  assert.strictEqual(S.grade({ signals: { errors: { value: 212 } } }), 'unknown');
});

test('unknown is not ok: an unrecognised status does not fall through to healthy', () => {
  // The old UI did `{...}[status] || 'h-ok'`, so any new status rendered green.
  assert.strictEqual(S.grade({ status: 'off' }), 'unknown');
  assert.strictEqual(S.grade({ status: 'degraded' }), 'unknown');
  assert.strictEqual(S.grade({}), 'unknown');
});

test('the worst signal wins, and unknown loses to any real reading', () => {
  assert.strictEqual(S.worst(['ok', 'warn', 'unknown']), 'warn');
  assert.strictEqual(S.worst(['unknown', 'ok']), 'ok');
  assert.strictEqual(S.worst(['bad', 'warn']), 'bad');
  assert.strictEqual(S.worst([]), 'unknown');
  assert.strictEqual(S.worst(['nonsense']), 'unknown');
});

test('a declared failure severity can override an otherwise healthy reading', () => {
  const c = { status: 'ok', failures: [{ name: 'restarts', count: 24522, severity: 'bad' }] };
  assert.strictEqual(S.grade(c), 'bad');
});

test('per-component bands beat the defaults', () => {
  const c = { signals: { errors: { value: 30, of: 1000 } } };   // 3 %
  assert.strictEqual(S.grade(c), 'warn');
  assert.strictEqual(S.grade(c, { warn: 0.05, bad: 0.2 }), 'ok');
});

test('a stale reading turns every component unknown and says so', () => {
  const out = at({ generated: '2026-11-06T09:50:00Z', components: { x: { status: 'ok', lines: ['pm2 online'] } } });
  assert.strictEqual(out.stale, true);
  assert.strictEqual(out.components.x.status, 'unknown');
  assert.ok(out.components.x.lines.includes('reading is stale'));
});

test('a fresh reading is graded normally', () => {
  const out = at({ generated: '2026-11-06T09:59:30Z', components: { x: { status: 'ok' } } });
  assert.strictEqual(out.stale, false);
  assert.strictEqual(out.components.x.status, 'ok');
});

test('a payload with no components is refused rather than shown as empty health', () => {
  assert.strictEqual(S.normalize(null).ok, false);
  assert.strictEqual(S.normalize({}).ok, false);
  assert.strictEqual(S.normalize({ components: 'nope' }).ok, false);
});

test('the rate line always carries the denominator', () => {
  assert.strictEqual(S.rateLine({ errors: { value: 212, of: 1840 }, traffic: { value: 1840, unit: 'req/h' } }),
    '11.5 % of 1,840 req/h');
  assert.strictEqual(S.rateLine({ errors: { value: 212 } }), null);
});

test('links must be absolute http(s) to be offered', () => {
  const c = one({ status: 'ok', links: [
    { label: 'errors', url: 'https://obs.example/e' },
    { label: 'bad', url: 'javascript:alert(1)' },
    { label: 'rel', url: '/errors' },
  ] });
  assert.deepStrictEqual(c.links, [{ label: 'errors', url: 'https://obs.example/e' }]);
});

test('deploy is carried through for change correlation', () => {
  const c = one({ status: 'bad', deploy: { at: '2026-11-06T07:00:00Z', ref: 'PR #221' } });
  assert.deepStrictEqual(c.deploy, { at: '2026-11-06T07:00:00Z', ref: 'PR #221' });
  assert.strictEqual(one({ status: 'ok' }).deploy, null);
});

test('the rail lists bad, warn and unknown, worst first, and skips healthy', () => {
  const out = at({ generated: '2026-11-06T09:59:30Z', components: {
    quiet:   { status: 'ok' },
    slow:    { signals: { errors: { value: 30, of: 1000 } } },
    gateway: { status: 'ok', failures: [{ name: 'restarts', count: 24522, window: '9h', severity: 'bad' }] },
    gone:    {},
  } });
  const rail = S.attention(out);
  assert.deepStrictEqual(rail.map(r => r.id), ['gateway', 'slow', 'gone']);
  assert.match(rail[0].why, /restarts 24,522 \/ 9h/);
  assert.ok(!rail.some(r => r.id === 'quiet'), 'healthy components do not interrupt anyone');
});

test('the rail is empty when the payload was refused', () => {
  assert.deepStrictEqual(S.attention(S.normalize(null)), []);
});
