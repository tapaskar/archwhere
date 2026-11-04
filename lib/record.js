'use strict';
// archwhere record: an append-only, attributed, hash-linked log that agents and humans share.
// Storage: one JSONL segment per clone under .archwhere/record/ (see docs/RECORD.md for why).
// Tamper-EVIDENT, not tamper-proof: see the limits in docs/RECORD.md. Zero dependencies.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const FORMAT = 1;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_SEGMENT_BYTES = 512 * 1024 * 1024;
const LOCK_TIMEOUT_MS = 15000;
const HUMAN = 'human';

const TYPES = ['spec', 'decision', 'finding', 'correction', 'review', 'work', 'signoff', 'claim', 'claim-update', 'ask'];
const TEXT_FIELDS = ['title', 'body', 'question', 'note', 'name', 'task', 'type', 'via', 'verdict', 'decision', 'branch', 'role', 'ts', 'status', 'claim_id', 'expires_at', 'sha256', 'supersedes', 'corrects', 'target', 'commit', 'url', 'signer', 'key_id', 'signature', 'signed_at', 'takes_over'];
const SEG_FILE = /^log-([0-9a-f]{16,64})\.jsonl$/;
const HASH = /^[0-9a-f]{64}$/;
const COMPONENT = /^[a-z0-9-]{1,100}$/;
const TASK = /^[A-Za-z0-9][A-Za-z0-9._:#/-]{0,127}$/;
const SPEC_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT = /^[0-9a-f]{7,64}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

// A log can't forget. Refuse what looks like a credential instead of storing it for ever.
const SECRET_PATTERNS = [
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['private key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['API key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}\b/],
];

class RecordError extends Error {
  constructor(code, message, extra) { super(message); this.code = code; Object.assign(this, extra); }
}
const fail = (code, msg, extra) => { throw new RecordError(code, msg, extra); };

const sha256 = x => crypto.createHash('sha256').update(x).digest('hex');
const isoNow = () => new Date().toISOString();

// ---------- canonical form and hashing ----------

/** Deterministic JSON: sorted keys, no whitespace. Built as a string so a "__proto__" key stays plain data. */
function canonical(v) {
  if (v === null || typeof v !== 'object') {
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol') fail('invalid', 'value cannot be recorded');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

function hashOf(entry) {
  const { hash: _ignored, ...rest } = entry;
  return sha256('archwhere-record-v1\n' + canonical(rest));
}

/** The prev of a segment's first entry, bound to its id so a chain can't be passed off as another segment. */
const genesis = seg => sha256('archwhere-record-genesis-v1\n' + seg);

/** Would these characters survive a trip through UTF-8 unchanged? (false for lone surrogates) */
const roundTrips = s => Buffer.from(s, 'utf8').toString('utf8') === s;

// ---------- where the record lives ----------

function gitOut(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/**
 * Where the default record hangs: the MAIN worktree, so agents in separate `git worktree`s share one
 * record and one lock. (Each worktree getting its own record would defeat claims, the common case.)
 */
function recordHome(root) {
  try {
    const common = path.resolve(root, gitOut(root, ['rev-parse', '--git-common-dir']));
    if (path.basename(common) === '.git') return { home: path.dirname(common), sub: ['.archwhere', 'record'] };
    return { home: common, sub: ['archwhere', 'record'] }; // bare repo or submodule: keep it out of any tree
  } catch { return { home: root, sub: ['.archwhere', 'record'] }; }
}

/** The nearest existing ancestor's real path + whatever doesn't exist yet: stops a symlink escaping. */
function realish(p) {
  let cur = path.resolve(p); const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const up = path.dirname(cur);
      if (up === cur) return path.join(cur, ...rest);
      rest.unshift(path.basename(cur)); cur = up;
    }
  }
}
const isInside = (parent, child) => {
  const r = path.relative(parent, child);
  return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r));
};

/**
 * explicit flag > ARCHWHERE_RECORD_DIR > the default. Only the operator sets the first two. The default
 * must stay inside the repo even through symlinks: a cloned repo must not be able to aim it elsewhere.
 */
function resolveDir(root, explicit, env = process.env) {
  const chosen = explicit || env.ARCHWHERE_RECORD_DIR;
  if (chosen) return path.resolve(root, chosen);
  const { home, sub } = recordHome(root);
  const dir = path.join(home, ...sub);
  if (!isInside(realish(home), realish(dir))) fail('path', `refusing the record dir: ${dir} resolves outside the repo (symlink?)`);
  return dir;
}

// ---------- locking ----------

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const sleepMs = ms => Atomics.wait(sleepCell, 0, 0, ms);

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function readLock(file) {
  try {
    const st = fs.statSync(file);
    let info = null;
    try { info = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* half-written */ }
    return { info, age: Date.now() - st.mtimeMs };
  } catch { return null; }
}

/** A dead pid on this host, or very old. A live pid is only given up on after 10 minutes: holds last milliseconds. */
function lockIsStale(l) {
  if (!l) return false;
  if (!l.info) return l.age > 5000;
  if (l.info.host === os.hostname()) return !pidAlive(l.info.pid) || l.age > 600000;
  return l.age > 60000;
}

/** Only one process at a time may break a stale lock, or two could each remove a lock the other just took. */
function breakStaleLock(file) {
  const breaker = file + '.breaker';
  let fd;
  try { fd = fs.openSync(breaker, 'wx', 0o600); }
  catch {
    try { if (Date.now() - fs.statSync(breaker).mtimeMs > 30000) fs.unlinkSync(breaker); } catch { /* gone */ }
    return;
  }
  try {
    fs.closeSync(fd);
    if (lockIsStale(readLock(file))) { try { fs.unlinkSync(file); } catch { /* gone */ } }
  } finally { try { fs.unlinkSync(breaker); } catch { /* gone */ } }
}

/** Exclusive lock for one filesystem: O_EXCL file with holder pid + host. Works across processes and worktrees. */
function withLock(dir, fn, { timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  const file = path.join(dir, '.lock');
  const token = crypto.randomBytes(8).toString('hex');
  const body = JSON.stringify({ pid: process.pid, host: os.hostname(), token, at: Date.now() });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeSync(fd, body); } finally { fs.closeSync(fd); }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (lockIsStale(readLock(file))) breakStaleLock(file);
      if (Date.now() > deadline) fail('locked', `the record is locked (${file}); another writer is busy or stuck`);
      sleepMs(2 + Math.floor(Math.random() * 20));
    }
  }
  try { return fn(); }
  finally {
    try {
      const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cur.token === token) fs.unlinkSync(file);
    } catch { /* already broken */ }
  }
}

// ---------- reading ----------

function segmentIds(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return names.map(n => (n.match(SEG_FILE) || [])[1]).filter(Boolean).sort();
}

/** Raw lines of one segment. Symlinks are refused: the record reads and appends only regular files. */
function readSegment(dir, id) {
  const file = path.join(dir, `log-${id}.jsonl`);
  const st = fs.lstatSync(file);
  if (!st.isFile()) fail('path', `${file} is not a regular file (symlink?); refusing it`);
  if (st.size > MAX_SEGMENT_BYTES) fail('too-large', `${file} is over ${MAX_SEGMENT_BYTES} bytes`);
  const text = fs.readFileSync(file, 'utf8');
  const parts = text.split('\n');
  const tail = parts.pop(); // '' when the file ends in a newline; otherwise an interrupted write
  return { id, lines: parts, torn: tail };
}

/**
 * Check one segment's chain. Every line must be: its own canonical form, in sequence, linked to the
 * line before, and hash to itself. Returns { entries, head, errors }.
 */
function checkChain(id, lines) {
  const errors = []; const entries = [];
  const err = (kind, line, detail) => errors.push({ kind, segment: id, line: line + 1, detail });
  let prev = genesis(id); let head = null;
  lines.forEach((line, i) => {
    let e;
    try { e = JSON.parse(line); } catch { err('malformed', i, 'not valid JSON'); return; }
    if (!e || typeof e !== 'object' || Array.isArray(e)) { err('malformed', i, 'not an object'); return; }
    if (canonical(e) !== line) err('edited', i, 'line is not in canonical form');
    if (hashOf(e) !== e.hash) err('edited', i, 'content does not match its hash');
    if (e.seg !== id) err('wrong-segment', i, `entry belongs to segment ${String(e.seg).slice(0, 16)}`);
    if (e.seq !== i) err('sequence', i, `expected seq ${i}, found ${e.seq}: an entry was deleted, inserted or moved`);
    if (e.prev !== prev) err('broken-link', i, 'prev does not match the entry before: an entry was deleted, inserted or moved');
    for (const f of ['author', 'agent', 'model', 'vendor']) {
      if (typeof e[f] !== 'string' || !e[f]) err('unattributed', i, `missing ${f}`);
    }
    // The hash covers these, so an attacker can make them hash-valid: don't let wrong types reach the readers.
    for (const f of TEXT_FIELDS) {
      if (e[f] !== undefined && typeof e[f] !== 'string') { err('invalid-entry', i, `${f} is not text`); delete e[f]; }
    }
    for (const f of ['components', 'refs']) {
      if (e[f] !== undefined && !(Array.isArray(e[f]) && e[f].every(x => typeof x === 'string'))) { err('invalid-entry', i, `${f} is not a list of text`); delete e[f]; }
    }
    prev = typeof e.hash === 'string' ? e.hash : prev;
    head = { seq: e.seq, hash: e.hash };
    entries.push(e);
  });
  return { entries, head, errors };
}

/** k-way merge that keeps each segment's own order; across segments, by declared time (a best effort). */
function mergeOrder(segs) {
  const idx = segs.map(() => 0); const out = [];
  for (;;) {
    let best = -1;
    segs.forEach((s, i) => {
      if (idx[i] >= s.entries.length) return;
      if (best === -1 || String(s.entries[idx[i]].ts) < String(segs[best].entries[idx[best]].ts)) best = i;
    });
    if (best === -1) return out;
    out.push(segs[best].entries[idx[best]++]);
  }
}

/** Everything in the record. Never creates files. chainOk is false if any segment fails its chain check. */
function load(dir) {
  const segments = segmentIds(dir).map(id => {
    const raw = readSegment(dir, id);
    return { ...raw, ...checkChain(id, raw.lines) };
  });
  return {
    dir, segments, entries: mergeOrder(segments),
    chainOk: segments.every(s => !s.errors.length),
    errors: segments.flatMap(s => s.errors),
  };
}

const digestOf = heads => sha256(heads.map(h => `${h.id}:${h.seq}:${h.hash}`).sort().join('\n'));
const headsOf = segments => segments.filter(s => s.head).map(s => ({ id: s.id, seq: s.head.seq, hash: s.head.hash }));

// ---------- writing ----------

const WITNESS = '.local-head.json';
const SEGMENT_ID = '.local-segment';

function readWitness(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, WITNESS), 'utf8')); } catch { return null; }
}

function writeWitness(dir, segments) {
  const w = {};
  for (const h of headsOf(segments)) w[h.id] = { seq: h.seq, hash: h.hash };
  const tmp = path.join(dir, `${WITNESS}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ segments: w }) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, WITNESS));
}

/** The record stays out of git unless someone opts in: a nested .gitignore that also ignores itself. */
function writeIgnore(dir, commit) {
  const file = path.join(dir, '.gitignore');
  try { if (!fs.lstatSync(file).isFile()) fail('path', `${file} is not a regular file; refusing it`); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.writeFileSync(file, commit
    ? '# archwhere record: committed by choice. Only per-clone state is ignored.\n.lock*\n.local-*\n'
    : '# archwhere record: not committed. It can hold sensitive text. See docs/RECORD.md.\n*\n');
}

function ensureDir(dir) {
  if (fs.existsSync(dir) && !fs.lstatSync(dir).isDirectory()) fail('path', `${dir} is not a directory`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let present = true;
  try { fs.lstatSync(path.join(dir, '.gitignore')); } catch { present = false; }
  if (!present) writeIgnore(dir, false);
}

function localSegment(dir) {
  const file = path.join(dir, SEGMENT_ID);
  try {
    const id = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{16,64}$/.test(id)) return id;
  } catch { /* first write from this clone */ }
  const id = crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(file, id + '\n', { mode: 0o600, flag: 'wx' }); // wx: never follows a planted symlink
  return id;
}

function refuseSecrets(entry) {
  const text = [entry.title, entry.body, entry.question, entry.note, ...(entry.refs || [])].filter(Boolean).join('\n');
  for (const [name, re] of SECRET_PATTERNS) {
    if (re.test(text)) fail('secret', `refusing to record this: it looks like it contains a ${name}, and an append-only log can't forget`);
  }
}

const singleLine = (v, name, max = 200) => {
  if (typeof v !== 'string' || !v.trim()) fail('invalid', `${name} is required`);
  // eslint-disable-next-line no-control-regex
  if (v.length > max || /[\u0000-\u001f\u007f]/.test(v)) fail('invalid', `${name} must be one line of at most ${max} characters`);
  return v;
};

/** Who is writing. Every entry names all of these; a human entry has no agent, model or vendor of its own. */
function attribution({ actor = 'agent', author, agent, model, vendor, via } = {}) {
  if (actor !== 'agent' && actor !== HUMAN) fail('invalid', 'actor must be "agent" or "human"');
  const a = {
    actor, author: singleLine(author, 'author'),
    agent: actor === HUMAN ? HUMAN : singleLine(agent, 'agent'),
    model: actor === HUMAN ? HUMAN : singleLine(model, 'model'),
    vendor: actor === HUMAN ? HUMAN : singleLine(vendor, 'vendor'),
  };
  if (via) a.via = singleLine(via, 'via');
  return a;
}

/** Flags beat env; the author falls back to git's user.name. Throws, naming what's missing. */
function identityFrom(flags = {}, env = process.env, root = process.cwd()) {
  const pick = (f, e) => flags[f] || env[e] || '';
  let author = pick('author', 'ARCHWHERE_AUTHOR');
  if (!author) { try { author = gitOut(root, ['config', 'user.name']); } catch { /* none */ } }
  const id = { actor: flags.human ? HUMAN : 'agent', author, agent: pick('agent', 'ARCHWHERE_AGENT'),
    model: pick('model', 'ARCHWHERE_MODEL_ID'), vendor: pick('vendor', 'ARCHWHERE_VENDOR') };
  const needed = flags.human ? ['author'] : ['author', 'agent', 'model', 'vendor'];
  const missing = needed.filter(k => !id[k]);
  if (missing.length) {
    fail('identity', `missing ${missing.join(', ')}: pass ${missing.map(m => '--' + m).join(' ')}, or set `
      + 'ARCHWHERE_AUTHOR / ARCHWHERE_AGENT / ARCHWHERE_MODEL_ID / ARCHWHERE_VENDOR');
  }
  return attribution(id);
}

/**
 * Run `fn` holding the lock, with a fresh view of the record. ctx.add(draft) seals and appends an entry.
 * The read-check-append is one atomic step: this is what makes claims and spec versions safe.
 */
function transact(dir, fn, opts) {
  ensureDir(dir);
  return withLock(dir, () => {
    const state = load(dir);
    const seg = localSegment(dir);
    let cur = state.segments.find(s => s.id === seg);
    if (cur && cur.torn) {
      fail('torn', `the last write to ${seg} was interrupted; run \`archwhere record repair\` and check \`record verify\``);
    }
    if (cur && cur.errors.length) {
      fail('tampered', `refusing to extend segment ${seg}: its chain does not verify (${cur.errors[0].kind} at line ${cur.errors[0].line}). Run \`archwhere record verify\``);
    }
    if (!cur) {
      cur = { id: seg, lines: [], torn: '', entries: [], head: null, errors: [] };
      state.segments.push(cur);
    }
    const ctx = {
      entries: state.entries, chainOk: state.chainOk, dir, segment: seg,
      add(draft) {
        const entry = seal(draft, cur);
        const line = canonical(entry);
        if (Buffer.byteLength(line) > MAX_ENTRY_BYTES) fail('too-large', `entry is over ${MAX_ENTRY_BYTES} bytes`);
        const file = path.join(dir, `log-${seg}.jsonl`);
        if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) fail('path', `${file} is not a regular file; refusing it`);
        const fd = fs.openSync(file, 'a', 0o600);
        try { fs.writeSync(fd, line + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        cur.lines.push(line); cur.entries.push(entry); cur.head = { seq: entry.seq, hash: entry.hash };
        state.entries.push(entry);
        writeWitness(dir, state.segments);
        return entry;
      },
    };
    return fn(ctx);
  }, opts);
}

function seal(draft, cur) {
  if (!TYPES.includes(draft.type)) fail('invalid', `unknown entry type "${draft.type}"`);
  const { type, attr, ...fields } = draft;
  for (const v of Object.values(fields)) {
    if (typeof v === 'string' && !roundTrips(v)) fail('invalid', 'text is not valid Unicode: it could not be stored word for word');
  }
  const a = attribution(attr);
  const entry = {
    v: FORMAT, seg: cur.id, seq: cur.entries.length, prev: cur.head ? cur.head.hash : genesis(cur.id),
    ts: isoNow(), type, ...a, ...fields,
  };
  for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
  refuseSecrets(entry);
  entry.hash = hashOf(entry);
  return entry;
}

// ---------- entry validation ----------

function commonFields(d, known) {
  const out = {};
  if (d.title !== undefined) out.title = singleLine(d.title, 'title', 300);
  if (d.body !== undefined) {
    if (typeof d.body !== 'string') fail('invalid', 'body must be text');
    if (Buffer.byteLength(d.body) > MAX_BODY_BYTES) fail('too-large', `body is over ${MAX_BODY_BYTES} bytes`);
    out.body = d.body;
  }
  if (d.task !== undefined) out.task = checkTask(d.task);
  if (d.components !== undefined && d.components.length) out.components = checkComponents(d.components, known);
  if (d.refs !== undefined && d.refs.length) {
    if (!Array.isArray(d.refs) || d.refs.length > 50) fail('invalid', 'refs: at most 50');
    out.refs = d.refs.map(r => singleLine(r, 'ref'));
  }
  return out;
}

function checkTask(t) {
  if (typeof t !== 'string' || !TASK.test(t)) fail('invalid', 'task ids are letters, digits and . _ : # / - (at most 128)');
  return t;
}

function checkComponents(list, known) {
  if (!Array.isArray(list) || list.length > 50) fail('invalid', 'components: a list of at most 50');
  for (const c of list) {
    if (typeof c !== 'string' || !COMPONENT.test(c)) fail('invalid', `bad component id: ${String(c).slice(0, 80)}`);
    if (known && !known.includes(c)) fail('unknown-component', `unknown component "${c}"; the map has: ${known.join(', ')}`);
  }
  return list;
}

/** Find an entry by full hash or a unique prefix of at least 8 characters. */
function findEntry(entries, ref) {
  if (typeof ref !== 'string' || !/^[0-9a-f]{8,64}$/.test(ref)) fail('invalid', 'hash must be 8 to 64 hex characters');
  const hits = entries.filter(e => typeof e.hash === 'string' && e.hash.startsWith(ref));
  if (hits.length > 1) fail('ambiguous', `hash prefix ${ref} matches ${hits.length} entries`);
  return hits[0] || null;
}

function mustFind(entries, ref, what) {
  const e = findEntry(entries, ref);
  if (!e) fail('not-found', `${what}: no entry ${ref}`);
  return e;
}

const VERDICTS = ['approve', 'changes', 'comment'];

/** Add a decision, finding, correction, review, work or ask entry. `known` is the map's component ids. */
function put(dir, attr, draft, { known } = {}) {
  const fields = commonFields(draft, known);
  const type = draft.type;
  if (!['decision', 'finding', 'correction', 'review', 'work', 'ask'].includes(type)) fail('invalid', `put cannot write "${type}" entries`);
  return transact(dir, ctx => {
    if (type === 'decision' || type === 'finding') {
      if (!fields.title) fail('invalid', `a ${type} needs a title`);
    }
    if (type === 'correction') {
      fields.corrects = mustFind(ctx.entries, draft.corrects, 'corrects').hash;
      if (!fields.body) fail('invalid', 'a correction needs a body saying what is wrong');
    }
    if (type === 'review') {
      if (!VERDICTS.includes(draft.verdict)) fail('invalid', `verdict must be one of ${VERDICTS.join(', ')}`);
      fields.verdict = draft.verdict;
      if (draft.target) fields.target = mustFind(ctx.entries, draft.target, 'target').hash;
      if (!fields.target && !fields.task) fail('invalid', 'a review needs a target entry or a task');
      if (draft.commit) fields.commit = checkCommit(draft.commit);
    }
    if (type === 'work') {
      if (!fields.task) fail('invalid', 'a work entry needs a task');
      if (draft.commit) fields.commit = checkCommit(draft.commit);
      if (draft.branch) fields.branch = checkBranch(draft.branch);
      if (draft.pr !== undefined) {
        if (!Number.isInteger(draft.pr) || draft.pr < 1) fail('invalid', 'pr must be a number');
        fields.pr = draft.pr;
      }
    }
    if (type === 'ask') {
      fields.question = singleLine(draft.question, 'question', 1000);
      if (draft.url) fields.url = singleLine(draft.url, 'url', 500);
      if (draft.issue) fields.issue = draft.issue;
    }
    return ctx.add({ type, attr, ...fields });
  });
}

function checkCommit(c) {
  if (typeof c !== 'string' || !COMMIT.test(c)) fail('invalid', 'commit must be a hex SHA');
  return c;
}
function checkBranch(b) {
  if (typeof b !== 'string' || !BRANCH.test(b) || b.includes('..')) fail('invalid', 'not a usable branch name');
  return b;
}

// ---------- specs ----------

/** Store a spec word for word. A changed text is a new version that links to the one before; nothing is edited. */
function putSpec(dir, attr, { name, text, components, task, supersedes, title }, { known } = {}) {
  if (typeof name !== 'string' || !SPEC_NAME.test(name)) fail('invalid', 'spec names are letters, digits and . _ - (at most 128)');
  if (typeof text !== 'string' || !text.length) fail('invalid', 'a spec needs text');
  if (!roundTrips(text)) fail('invalid', 'spec text is not valid Unicode: it could not be stored word for word');
  const fields = commonFields({ body: text, components, task, title }, known);
  const digest = sha256(Buffer.from(text, 'utf8'));
  return transact(dir, ctx => {
    const line = specVersions(ctx.entries, name);
    const heads = specHeads(line);
    if (supersedes !== undefined && supersedes !== null && !line.some(v => v.sha256 === supersedes)) {
      fail('not-found', `no version ${supersedes} of spec "${name}"`);
    }
    if (line.length) {
      const head = heads[heads.length - 1];
      if (supersedes && !heads.some(h => h.sha256 === supersedes)) {
        fail('conflict', `spec "${name}" has moved on: its current version is ${head.sha256}, not ${supersedes}. Read it, then retry.`, { current: head.sha256 });
      }
      if (head.sha256 === digest) return { entry: head, unchanged: true };
    }
    const base = line.length ? (heads.find(h => h.sha256 === supersedes) || heads[heads.length - 1]) : null;
    const prior = supersedes || (base ? base.sha256 : undefined);
    // A new version stays tied to the same components and task unless it says otherwise.
    const inherited = base ? { components: base.components, task: base.task, title: base.title } : {};
    const entry = ctx.add({ type: 'spec', attr, name, sha256: digest, version: line.length + 1, supersedes: prior, ...inherited, ...fields });
    return { entry, unchanged: false };
  });
}

const specVersions = (entries, name) => entries.filter(e => e.type === 'spec' && e.name === name);

/** Versions nothing supersedes: normally one; two means separate clones each changed it. */
function specHeads(versions) {
  const replaced = new Set(versions.map(v => v.supersedes).filter(Boolean));
  const heads = versions.filter(v => !replaced.has(v.sha256));
  return heads.length ? heads : versions.slice(-1);
}

function getSpec(entries, { name, sha256: digest, version } = {}) {
  const all = entries.filter(e => e.type === 'spec');
  if (digest) return all.find(e => e.sha256 === digest && (!name || e.name === name)) || null;
  if (!name) fail('invalid', 'give a spec name or a sha256');
  const line = specVersions(all, name);
  if (version !== undefined) return line.find(e => e.version === version) || null;
  const heads = specHeads(line);
  return heads.length ? heads[heads.length - 1] : null;
}

function listSpecs(entries, { component } = {}) {
  const names = [...new Set(entries.filter(e => e.type === 'spec').map(e => e.name))];
  return names.map(name => {
    const versions = specVersions(entries, name);
    const heads = specHeads(versions);
    const head = heads[heads.length - 1];
    return {
      name, version: head.version, versions: versions.length, sha256: head.sha256,
      components: head.components || [], task: head.task, title: head.title,
      author: head.author, agent: head.agent, ts: head.ts,
      ...(heads.length > 1 ? { forked: heads.map(h => h.sha256) } : {}),
    };
  }).filter(s => !component || s.components.includes(component));
}

// ---------- search ----------

const SEARCHED = ['title', 'body', 'question', 'note', 'name', 'task', 'type', 'author', 'agent', 'model', 'vendor', 'verdict', 'decision', 'branch'];

/** Plain text (case-insensitive, all words must appear), by component, task and type; newest first. */
function search(entries, { text, component, task, type, limit = 50 } = {}) {
  const words = String(text || '').toLowerCase().split(/\s+/).filter(Boolean);
  const hits = entries.filter(e => {
    if (component && !(e.components || []).includes(component)) return false;
    if (task && e.task !== task) return false;
    if (type && e.type !== type) return false;
    if (!words.length) return true;
    const hay = SEARCHED.map(k => e[k]).concat(e.components || [], e.refs || []).filter(v => typeof v === 'string').join('\n').toLowerCase();
    return words.every(w => hay.includes(w));
  });
  return { total: hits.length, entries: hits.reverse().slice(0, limit) };
}

// ---------- verify ----------

/** Cross-entry rules: a spec's hash matches its text, and references point at entries that exist. */
function semanticErrors(entries) {
  const errors = []; const warnings = [];
  const hashes = new Set(entries.map(e => e.hash));
  const specShas = new Set(entries.filter(e => e.type === 'spec').map(e => e.sha256));
  const lastTs = {};
  for (const e of entries) {
    const at = { segment: e.seg, line: e.seq + 1 };
    if (!TYPES.includes(e.type)) warnings.push(`unknown entry type "${e.type}" in ${String(e.seg).slice(0, 8)} line ${e.seq + 1}`);
    if (e.type === 'spec') {
      if (typeof e.body !== 'string' || sha256(Buffer.from(e.body, 'utf8')) !== e.sha256) {
        errors.push({ kind: 'spec-hash', ...at, detail: `spec "${e.name}" text does not match its sha256` });
      }
      if (e.supersedes && !specShas.has(e.supersedes)) {
        errors.push({ kind: 'dangling', ...at, detail: `spec "${e.name}" supersedes a version that isn't here` });
      }
    }
    for (const f of ['corrects', 'target']) {
      if (e[f] && !hashes.has(e[f])) errors.push({ kind: 'dangling', ...at, detail: `${f} points at an entry that isn't here` });
    }
    if (lastTs[e.seg] && e.ts < lastTs[e.seg]) warnings.push(`clock went backwards in ${String(e.seg).slice(0, 8)} at line ${e.seq + 1}`);
    lastTs[e.seg] = e.ts;
  }
  return { errors, warnings };
}

function checkAgainst(kind, segments, marks) {
  const errors = [];
  for (const [id, m] of Object.entries(marks)) {
    const s = segments.find(x => x.id === id);
    const at = s && s.entries[m.seq];
    if (!s) errors.push({ kind, segment: id, detail: `segment ${id.slice(0, 16)} is missing (deleted, or never imported here)` });
    else if (!at) errors.push({ kind, segment: id, line: m.seq + 1, detail: `entries up to line ${m.seq + 1} existed; the segment now ends at ${s.entries.length}: tail deleted` });
    else if (at.hash !== m.hash) errors.push({ kind, segment: id, line: m.seq + 1, detail: 'the entry at this position has a different hash: rewritten' });
  }
  return errors;
}

/**
 * Check everything checkable. Detects edits, deletions, insertions and reordering inside a segment;
 * tail deletion and whole-chain rewrites only against a witness (weak, same directory) or anchors (strong).
 * opts: { signers: array from signoff.loadSigners, anchors: [{ source, segments }] }.
 */
function verify(dir, opts = {}) {
  let state = load(dir);
  // A reader can catch a writer mid-line. Only call it torn if it stays that way.
  if (state.segments.some(s => s.torn)) { sleepMs(150); state = load(dir); }
  const errors = [...state.errors];
  const warnings = [];
  for (const s of state.segments) {
    if (s.torn) errors.push({ kind: 'torn', segment: s.id, line: s.lines.length + 1, detail: 'the last line is incomplete (interrupted write, or truncated)' });
  }
  const sem = semanticErrors(state.entries);
  errors.push(...sem.errors); warnings.push(...sem.warnings);
  const heads = headsOf(state.segments);
  const witness = readWitness(dir);
  let witnessState = 'absent';
  if (witness && witness.segments) {
    const bad = checkAgainst('witness-mismatch', state.segments, witness.segments);
    errors.push(...bad);
    witnessState = bad.length ? 'mismatch' : 'ok';
  } else if (state.entries.length) {
    warnings.push('no local head witness (a fresh clone or import?): deleting the newest entries would not show without an anchor');
  }
  const anchors = opts.anchors || [];
  for (const a of anchors) errors.push(...checkAgainst('anchor-mismatch', state.segments, a.segments).map(x => ({ ...x, anchor: a.source })));
  let signoffs = [];
  if (state.entries.some(e => e.type === 'signoff')) {
    const S = require('./signoff');
    signoffs = S.checkSignoffs(state.entries, opts.signers || []);
    for (const s of signoffs) {
      if (s.status === 'bad-signature') errors.push({ kind: 'bad-signature', segment: s.segment, line: s.line, detail: `sign-off ${s.hash.slice(0, 12)} by "${s.signer}" has an invalid signature` });
      if (s.status === 'unknown-key') warnings.push(`sign-off ${s.hash.slice(0, 12)} names "${s.signer}", whose key is not in the trusted signers: treat it as unverified`);
    }
  }
  return {
    ok: !errors.length, count: state.entries.length, digest: digestOf(heads), heads,
    segments: state.segments.map(s => ({ id: s.id, count: s.entries.length })),
    witness: witnessState, anchors_checked: anchors.length, anchored: anchors.length > 0,
    signoffs, errors, warnings,
  };
}

// ---------- anchors ----------

/** One line of hashes and counts: no record content, so it is safe to publish. */
function anchorText(dir) {
  const heads = headsOf(load(dir).segments);
  if (!heads.length) fail('empty', 'the record is empty: nothing to anchor');
  return `archwhere-record-anchor v1 digest=${digestOf(heads)} ` + heads.map(h => `${h.id}:${h.seq}:${h.hash}`).join(',');
}

function parseAnchors(text, source) {
  const out = [];
  const re = /archwhere-record-anchor v1 digest=([0-9a-f]{64}) ([0-9a-f:,]+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const segments = {};
    const heads = [];
    let good = true;
    for (const part of m[2].split(',')) {
      const p = part.match(/^([0-9a-f]{16,64}):(\d+):([0-9a-f]{64})$/);
      if (!p) { good = false; break; }
      segments[p[1]] = { seq: Number(p[2]), hash: p[3] };
      heads.push({ id: p[1], seq: Number(p[2]), hash: p[3] });
    }
    if (good && digestOf(heads) === m[1]) out.push({ source, digest: m[1], segments });
  }
  return out;
}

/** Anchors held in local git tags (`git fetch --tags` to see other people's). */
function tagAnchors(root) {
  let out = '';
  try {
    out = gitOut(root, ['for-each-ref', 'refs/tags/archwhere/record-anchor/', '--format=%(refname:short)%00%(contents)%00%00']);
  } catch { return []; }
  return out.split('\0\0').flatMap(chunk => {
    const [name, contents] = chunk.split('\0');
    return name && name.trim() ? parseAnchors(contents, 'tag ' + name.trim()) : [];
  });
}

// ---------- export, import, repair ----------

/** The complete record as JSONL: a header, then every line verbatim. Verifiable on any machine. */
function exportBundle(dir) {
  const state = load(dir);
  const heads = headsOf(state.segments);
  const header = {
    archwhere_record_export: FORMAT, exported_at: isoNow(), digest: digestOf(heads), count: state.entries.length,
    segments: state.segments.map(s => ({ id: s.id, count: s.lines.length })),
  };
  return [JSON.stringify(header), ...state.segments.flatMap(s => s.lines)].join('\n') + '\n';
}

/**
 * Import a bundle: each foreign segment stays its own file, so no entry is rewritten. Refuses a bundle
 * that doesn't verify, and a segment that has forked from what is already here.
 */
function importBundle(dir, text) {
  const lines = String(text).split('\n').filter(l => l.length);
  let header;
  try { header = JSON.parse(lines[0]); } catch { fail('invalid', 'not an archwhere record export'); }
  if (!header || header.archwhere_record_export !== FORMAT || !Array.isArray(header.segments)) fail('invalid', 'not an archwhere record export');
  let pos = 1; const incoming = [];
  for (const s of header.segments) {
    if (!/^[0-9a-f]{16,64}$/.test(String(s.id)) || !Number.isInteger(s.count) || s.count < 0) fail('invalid', 'bad segment in the export header');
    const chunk = lines.slice(pos, pos + s.count); pos += s.count;
    if (chunk.length !== s.count) fail('tampered', `the export is short: segment ${s.id} should have ${s.count} entries`);
    const chk = checkChain(s.id, chunk);
    if (chk.errors.length) fail('tampered', `segment ${s.id} does not verify: ${chk.errors[0].kind} at line ${chk.errors[0].line}`);
    incoming.push({ id: s.id, lines: chunk, head: chk.head });
  }
  if (pos !== lines.length) fail('tampered', 'the export has entries its header does not list');
  if (digestOf(incoming.filter(s => s.head).map(s => ({ id: s.id, ...s.head }))) !== header.digest) fail('tampered', 'the export digest does not match its entries');
  ensureDir(dir);
  return withLock(dir, () => {
    const state = load(dir);
    const added = [];
    for (const s of incoming) {
      const here = state.segments.find(x => x.id === s.id);
      const have = here ? here.lines : [];
      const shared = Math.min(have.length, s.lines.length);
      for (let i = 0; i < shared; i++) {
        if (have[i] !== s.lines[i]) fail('fork', `segment ${s.id} has forked from the local copy at line ${i + 1}; refusing to overwrite either`);
      }
      const fresh = s.lines.slice(have.length);
      if (!fresh.length) continue;
      const fd = fs.openSync(path.join(dir, `log-${s.id}.jsonl`), 'a', 0o600);
      try { fs.writeSync(fd, fresh.join('\n') + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      added.push({ segment: s.id, entries: fresh.length });
    }
    writeWitness(dir, load(dir).segments);
    return { added };
  });
}

/** After a crash: move an incomplete last line aside, keeping the bytes. Complete lines are never touched. */
function repair(dir) {
  return withLock(dir, () => {
    const out = [];
    for (const id of segmentIds(dir)) {
      const raw = readSegment(dir, id);
      if (!raw.torn) continue;
      const file = path.join(dir, `log-${id}.jsonl`);
      const keep = Buffer.byteLength(raw.lines.map(l => l + '\n').join(''));
      const aside = path.join(dir, `.local-torn-${id}-${Date.now()}.bin`);
      fs.writeFileSync(aside, raw.torn, { mode: 0o600 });
      fs.truncateSync(file, keep);
      out.push({ segment: id, moved_to: aside, bytes: Buffer.byteLength(raw.torn) });
    }
    return out;
  });
}

function init(dir, { commit = false } = {}) {
  ensureDir(dir);
  writeIgnore(dir, commit);
  return { dir, commit };
}

module.exports = {
  FORMAT, MAX_BODY_BYTES, MAX_ENTRY_BYTES, HUMAN, TYPES, RecordError, fail, sha256, canonical, hashOf, genesis,
  checkTask, checkBranch, checkComponents, realish, isInside, recordHome, resolveDir, withLock, load, checkChain,
  digestOf, headsOf, transact, attribution, identityFrom, findEntry, mustFind, put, putSpec, getSpec, listSpecs,
  specVersions, search, verify, anchorText, parseAnchors, tagAnchors, exportBundle, importBundle, repair, init, VERDICTS,
};
