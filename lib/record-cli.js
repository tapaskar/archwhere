'use strict';
// `archwhere record ...` and `archwhere task ...`: the command-line face of the record.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const W = require('./where');
const R = require('./record');
const C = require('./claims');
const S = require('./signoff');
const V = require('./review');
const { stripAnsi } = require('./bridge');

const USAGE = `
archwhere record: the shared record. Append-only, attributed, hash-linked.

  record init [--commit]                  create it; --commit opts in to committing it (see docs/RECORD.md)
  record spec put NAME --file F [--components a,b] [--task T] [--supersedes SHA]
  record spec get NAME|--sha256 S [--version N] [--raw]    --raw prints the exact bytes
  record spec list [--component C]
  record put decision|finding --title T [--body B | --file F] [--components a,b] [--task T]
  record put correction --corrects HASH --body B
  record put review --verdict approve|changes|comment (--task T | --target HASH) [--commit SHA] [--body B]
  record put work --task T [--branch B] [--commit SHA] [--pr N]
  record get HASH
  record search [TEXT] [--component C] [--task T] [--type TYPE] [--limit N]
  record export [--out FILE]              the whole record, verifiable anywhere
  record import FILE
  record verify [--strict] [--issue N] [--signers FILE] [--signers-ref REF]
  record anchor --tag [--push] | --issue N    publish the head hash outside this directory
  record repair                           move an interrupted last line aside after a crash
  record independent (--task T | --target HASH) [--commit SHA]   exit 1 unless independently approved
  record keygen --signer NAME [--key FILE] [--add]   owner signing key, passphrase-protected
  record signoff --target HASH --decision approve|reject --signer NAME [--note N] [--key FILE]

Who you are: --author --agent --model --vendor, or ARCHWHERE_AUTHOR / ARCHWHERE_AGENT /
ARCHWHERE_MODEL_ID / ARCHWHERE_VENDOR. --human writes as a person: that is only a claim
unless an owner sign-off covers it. Common: --dir DIR (or ARCHWHERE_RECORD_DIR), --json.
`;

const TASK_USAGE = `
archwhere task: several agents on one task, without collisions.

  task claim T --role builder|reviewer|tester [--branch B] [--ttl 30m]
  task renew CLAIM_ID [--ttl 30m]
  task release CLAIM_ID [--status done|released|failed] [--note N]
  task list [--task T] [--all]
  task check --branch B --agent A [--require]   exit 1 if someone else holds the branch

Who you are: as for \`archwhere record\`.
`;

const BOOL = new Set(['--json', '--raw', '--human', '--commit', '--strict', '--tag', '--push', '--add', '--all', '--require', '--help', '-h']);

function parse(args) {
  const flags = {}; const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-') || a === '-') { rest.push(a); continue; }
    const k = a.replace(/^-+/, '');
    if (BOOL.has(a) && !(a === '--commit' && args[i + 1] && !args[i + 1].startsWith('-') && rest[0] !== 'init')) { flags[k] = true; continue; }
    if (i + 1 >= args.length) R.fail('usage', `${a} needs a value`);
    flags[k] = args[++i];
  }
  return { flags, rest };
}

// eslint-disable-next-line no-control-regex
const clean = s => stripAnsi(String(s == null ? '' : s)).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '\ufffd');
const list = v => (v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : undefined);
const short = h => String(h || '').slice(0, 12);

function knownComponents(root, f) {
  try { return Object.keys(W.loadArch(root, f.arch).components); } catch { return undefined; }
}

function readText(f) {
  if (f.file === undefined) return f.body;
  const buf = fs.readFileSync(f.file);
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) R.fail('invalid', `${f.file} is not valid UTF-8: it could not be stored word for word`);
  return text;
}

function printEntry(e, extra = {}) {
  const who = e.actor === R.HUMAN ? `${clean(e.author)} (human)` : `${clean(e.author)} / ${clean(e.agent)} / ${clean(e.model)} / ${clean(e.vendor)}`;
  const label = [e.type, e.verdict, e.decision, e.name && `${e.name} v${e.version}`].filter(Boolean).map(clean).join(' ');
  console.log(`${short(e.hash)}  ${clean(e.ts)}  ${label}  [${who}]`);
  if (e.title) console.log(`    ${clean(e.title)}`);
  const tags = [e.task && `task ${clean(e.task)}`, e.components && `components ${e.components.map(clean).join(',')}`, extra.made_by && extra.made_by !== 'agent' && extra.made_by].filter(Boolean);
  if (tags.length) console.log(`    ${tags.join(' · ')}`);
  for (const s of extra.signed_by || []) console.log(`    signed by ${clean(s.signer)}: ${clean(s.decision)}`);
}

const out = (f, data, text) => { if (f.json) console.log(JSON.stringify(data, null, 2)); else text(); };

function trustFor(root, f) { return S.loadSigners(root, { file: f.signers, ref: f['signers-ref'] }); }

function annotate(root, f, entries) {
  const offs = entries.some(e => e.type === 'signoff') ? S.checkSignoffs(entries, trustFor(root, f).signers) : [];
  return e => S.whoMade(e, offs);
}

// ---------- passphrases: from the terminal only, so an agent's pipe can't supply one ----------

function promptSecret(question) {
  let fd;
  try { fd = fs.openSync('/dev/tty', 'r+'); }
  catch { R.fail('no-tty', 'this needs a person at a terminal: no controlling terminal, so no sign-off from a script or an agent'); }
  try {
    fs.writeSync(fd, question);
    spawnSync('stty', ['-echo'], { stdio: [fd, 'ignore', 'ignore'] });
    const bytes = []; const one = Buffer.alloc(1);
    while (fs.readSync(fd, one, 0, 1, null) === 1 && one[0] !== 10 && one[0] !== 13) bytes.push(one[0]);
    fs.writeSync(fd, '\n');
    return Buffer.from(bytes).toString('utf8');
  } finally {
    spawnSync('stty', ['echo'], { stdio: [fd, 'ignore', 'ignore'] });
    fs.closeSync(fd);
  }
}

// ---------- record ----------

function recordMain(root, args) {
  const sub = args.shift();
  const { flags: f, rest } = parse(args);
  if (!sub || sub === 'help' || f.help || f.h) { process.stdout.write(USAGE); return; }
  const dir = R.resolveDir(root, f.dir);

  if (sub === 'init') {
    const r = R.init(dir, { commit: !!f.commit });
    console.log(`record at ${r.dir}: ${r.commit ? 'WILL be committed. Everything in it becomes public in a public repo.' : 'ignored by git (the default).'}`);
    return;
  }
  if (sub === 'spec') return specCmd(root, dir, rest, f);
  if (sub === 'put') {
    const type = rest[0];
    const attr = R.identityFrom(f, process.env, root);
    const e = R.put(dir, attr, {
      type, title: f.title, body: readText(f), task: f.task, components: list(f.components), refs: list(f.refs),
      corrects: f.corrects, verdict: f.verdict, target: f.target, commit: f.commit, branch: f.branch, pr: f.pr ? Number(f.pr) : undefined,
    }, { known: knownComponents(root, f) });
    out(f, e, () => console.log(`recorded ${e.type} ${e.hash}`));
    return;
  }
  if (sub === 'get') {
    const state = R.load(dir);
    const e = R.findEntry(state.entries, rest[0]);
    if (!e) R.fail('not-found', `no entry ${clean(rest[0])}`);
    const who = annotate(root, f, state.entries)(e);
    out(f, { ...e, ...who }, () => {
      printEntry(e, who);
      if (typeof e.body === 'string') console.log('\n' + clean(e.body));
      if (!state.chainOk) console.log('\nWARNING: the record does not verify. Run: archwhere record verify');
    });
    return;
  }
  if (sub === 'search' || sub === 'log') {
    const state = R.load(dir);
    const found = R.search(state.entries, { text: rest.join(' '), component: f.component, task: f.task, type: f.type, limit: f.limit ? Number(f.limit) : 50 });
    const note = annotate(root, f, state.entries);
    out(f, { ...found, chain_ok: state.chainOk }, () => {
      for (const e of found.entries) printEntry(e, note(e));
      console.log(`${found.entries.length} of ${found.total}${state.chainOk ? '' : '   WARNING: the record does not verify'}`);
    });
    return;
  }
  if (sub === 'export') {
    const text = R.exportBundle(dir);
    if (f.out) {
      fs.writeFileSync(f.out, text, { mode: 0o600 });
      console.log(`wrote ${f.out}. It holds the whole record, so treat it as sensitive.`);
    } else process.stdout.write(text);
    return;
  }
  if (sub === 'import') {
    if (!rest[0]) R.fail('usage', 'record import FILE');
    const r = R.importBundle(dir, fs.readFileSync(rest[0], 'utf8'));
    out(f, r, () => console.log(r.added.length ? r.added.map(a => `added ${a.entries} from segment ${a.segment}`).join('\n') : 'nothing new'));
    return;
  }
  if (sub === 'verify') return verifyCmd(root, dir, f);
  if (sub === 'anchor') return anchorCmd(root, dir, f);
  if (sub === 'repair') {
    const r = R.repair(dir);
    out(f, r, () => console.log(r.length ? r.map(x => `moved ${x.bytes} bytes from ${x.segment} to ${x.moved_to}`).join('\n') : 'nothing to repair'));
    return;
  }
  if (sub === 'independent') {
    const r = V.independent(R.load(dir).entries, { task: f.task, target: f.target, commit: f.commit });
    out(f, r, () => {
      console.log(r.ok ? 'independent: yes' : 'independent: NO');
      for (const a of r.authors) console.log(`  author    ${clean(a.agent)} · ${clean(a.model)} · ${clean(a.vendor)}`);
      for (const v of r.reviews) {
        console.log(`  reviewer  ${clean(v.agent)} · ${clean(v.model)} · ${clean(v.vendor)} · ${clean(v.verdict)}: ${v.independent ? 'counts' : 'does not count'}`);
        for (const w of v.why) console.log(`            ${clean(w)}`);
      }
      for (const x of r.reasons) console.log(`  ${clean(x)}`);
      console.log(`  (${r.note})`);
    });
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (sub === 'keygen') return keygenCmd(root, f);
  if (sub === 'signoff') return signoffCmd(root, dir, f);
  R.fail('usage', `unknown record command "${clean(sub)}"\n${USAGE}`);
}

function specCmd(root, dir, rest, f) {
  const action = rest[0];
  if (action === 'put') {
    const attr = R.identityFrom(f, process.env, root);
    const text = readText({ file: f.file, body: f.text });
    const r = R.putSpec(dir, attr, { name: rest[1], text, components: list(f.components), task: f.task, title: f.title, supersedes: f.supersedes }, { known: knownComponents(root, f) });
    out(f, r, () => console.log(r.unchanged ? `unchanged: ${r.entry.name} v${r.entry.version} ${r.entry.sha256}` : `stored ${r.entry.name} v${r.entry.version} ${r.entry.sha256}`));
    return;
  }
  const state = R.load(dir);
  if (action === 'get') {
    const e = R.getSpec(state.entries, { name: rest[1], sha256: f.sha256, version: f.version ? Number(f.version) : undefined });
    if (!e) R.fail('not-found', 'no such spec');
    if (R.sha256(Buffer.from(e.body, 'utf8')) !== e.sha256) R.fail('tampered', `spec ${clean(e.name)} does not match its sha256. Run: archwhere record verify`);
    if (f.raw) { process.stdout.write(e.body); return; }
    out(f, e, () => { printEntry(e); console.log(`    sha256 ${e.sha256}${e.supersedes ? `   supersedes ${short(e.supersedes)}` : ''}\n\n${clean(e.body)}`); });
    return;
  }
  if (action === 'list') {
    const specs = R.listSpecs(state.entries, { component: f.component });
    out(f, specs, () => {
      for (const s of specs) console.log(`${clean(s.name)}  v${s.version}  ${short(s.sha256)}  ${s.components.map(clean).join(',')}${s.forked ? '   FORKED: separate clones changed this' : ''}`);
      if (!specs.length) console.log('no specs');
    });
    return;
  }
  R.fail('usage', 'record spec put|get|list');
}

function verifyCmd(root, dir, f) {
  const trust = trustFor(root, f);
  const anchors = R.tagAnchors(root);
  if (f.issue) anchors.push(...issueAnchors(root, f));
  const r = R.verify(dir, { signers: trust.signers, anchors });
  const unverified = r.signoffs.filter(s => s.status !== 'verified');
  const strictFail = f.strict && (r.warnings.length > 0 || !anchors.length || unverified.length > 0 || (r.signoffs.length > 0 && trust.weak));
  const ok = r.ok && !strictFail;
  out(f, { ...r, ok, signers_source: trust.source, signers_weak: trust.weak }, () => {
    for (const e of r.errors) console.log(`✗ ${e.kind}: ${String(e.segment || '').slice(0, 12)}${e.line ? ` line ${e.line}` : ''}: ${clean(e.detail)}${e.anchor ? ` [${clean(e.anchor)}]` : ''}`);
    for (const w of r.warnings) console.log(`! ${clean(w)}`);
    for (const s of r.signoffs) console.log(`  sign-off ${short(s.hash)} by ${clean(s.signer)} on ${short(s.target)}: ${clean(s.decision)}: ${s.status}`);
    if (r.signoffs.length) console.log(`  trusted signers from ${clean(trust.source)}${trust.weak ? ' (weak: anyone who can edit the working tree can add a key)' : ''}`);
    console.log(`${ok ? '✓' : '✗'} ${r.count} entries in ${r.segments.length} segment(s); digest ${r.digest}`);
    console.log(`  witness: ${r.witness}; anchors checked: ${r.anchors_checked}`);
    if (!r.anchors_checked) console.log('  not anchored: a full rewrite of this directory would not be noticed. See `archwhere record anchor`.');
    if (strictFail && r.ok) console.log('  --strict: warnings, unverified sign-offs, a weak trust list or no anchors count as failures');
  });
  if (!ok) process.exitCode = 1;
}

function githubFor(root, f) {
  const G = require('./gh'); const L = require('./rail');
  const { owner, repo } = f.repo
    ? (([o, r]) => ({ owner: o, repo: r }))(String(f.repo).split('/'))
    : L.parseRepo(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  return { gh: G.makeGh({ token: G.githubToken() }), owner, repo };
}

// Sync CLI, async fetch: run it in a child and wait, so verify stays one straight line.
function issueAnchors(root, f) {
  const script = `
    const G=require(${JSON.stringify(path.join(__dirname, 'gh.js'))});
    const gh=G.makeGh({token:G.githubToken()});
    gh(process.argv[1]).then(c=>process.stdout.write(JSON.stringify(c))).catch(e=>{process.stderr.write(e.message);process.exit(1)});`;
  const { owner, repo } = githubFor(root, f);
  const r = spawnSync(process.execPath, ['-e', script, `/repos/${owner}/${repo}/issues/${Number(f.issue)}/comments?per_page=100`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) R.fail('github', `could not read anchors from issue ${Number(f.issue)}: ${clean(r.stderr).slice(0, 200)}`);
  // Anyone can comment on a public repo. A fake anchor could only raise a false alarm, but ignore outsiders anyway.
  return JSON.parse(r.stdout).filter(c => ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(c.author_association))
    .flatMap(c => R.parseAnchors(c.body, `issue ${Number(f.issue)} comment by ${c.user && c.user.login}`));
}

function anchorCmd(root, dir, f) {
  const verified = R.verify(dir, { anchors: R.tagAnchors(root) });
  if (!verified.ok) R.fail('tampered', 'refusing to anchor a record that does not verify. Run: archwhere record verify');
  const text = R.anchorText(dir);
  if (f.tag) {
    const name = `archwhere/record-anchor/${verified.digest.slice(0, 16)}`;
    execFileSync('git', ['tag', '-a', name, '-m', text], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    if (f.push) execFileSync('git', ['push', 'origin', `refs/tags/${name}`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    console.log(`${f.push ? 'tagged and pushed' : 'tagged'} ${name}${f.push ? '' : '   (git push origin ' + name + ' to put it out of reach of this machine)'}`);
    return;
  }
  if (f.issue) {
    const { gh, owner, repo } = githubFor(root, f);
    gh(`/repos/${owner}/${repo}/issues/${Number(f.issue)}/comments`, { method: 'POST', body: JSON.stringify({ body: text }) })
      .then(c => console.log(`anchored in ${c.html_url}`))
      .catch(e => { console.error('archwhere record: ' + clean(e.message)); process.exitCode = 1; });
    return;
  }
  console.log(text);
}

function keygenCmd(root, f) {
  if (!f.signer) R.fail('usage', 'record keygen --signer NAME');
  const passphrase = promptSecret('New passphrase for the signing key: ');
  if (promptSecret('Again: ') !== passphrase) R.fail('passphrase', 'the passphrases differ');
  const k = S.keygen({ name: f.signer, passphrase, keyPath: f.key, root });
  console.log(`key written to ${k.key_path} (mode 600). Keep it off any machine or account an agent can read.`);
  const row = { name: k.name, key_id: k.key_id, public_key: k.public_key };
  if (f.add) {
    const file = path.join(root, S.SIGNERS_FILE);
    let cur = { signers: [] };
    try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new */ }
    cur.signers.push(row);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cur, null, 2) + '\n');
    console.log(`added to ${S.SIGNERS_FILE}. Merge it to the default branch, with branch protection on: that copy is what verify trusts.`);
  } else console.log(`add this to ${S.SIGNERS_FILE} on the default branch:\n` + JSON.stringify({ signers: [row] }, null, 2));
}

function signoffCmd(root, dir, f) {
  if (!f.target || !f.decision || !f.signer) R.fail('usage', 'record signoff --target HASH --decision approve|reject --signer NAME');
  const state = R.load(dir);
  const target = R.mustFind(state.entries, f.target, 'target');
  if (!state.chainOk) R.fail('tampered', 'refusing to sign: the record does not verify. Run: archwhere record verify');
  // The person signs what they are shown, so show it, cleaned of anything that could disguise it.
  const lines = clean(target.body || '').split('\n');
  const shown = lines.slice(0, 40).join('\n');
  const screen = [
    `You are about to ${f.decision.toUpperCase()} this entry as ${clean(f.signer)}:`,
    `  ${target.type} ${target.hash}`, `  by ${clean(target.author)} / ${clean(target.agent)} / ${clean(target.model)} / ${clean(target.vendor)}`,
    ...(target.title ? [`  ${clean(target.title)}`] : []), ...(shown ? ['', shown] : []),
    ...(lines.length > 40 ? [`… and ${lines.length - 40} more lines: read them with \`archwhere record get ${short(target.hash)}\``] : []), '',
  ].join('\n');
  const passphrase = promptSecret(screen + 'Passphrase to sign (Ctrl-C to stop): ');
  const e = S.signoff(dir, { target: target.hash, decision: f.decision, note: f.note, signer: f.signer, keyPath: f.key, passphrase });
  out(f, e, () => console.log(`signed: ${e.decision} on ${short(e.target)} as ${clean(e.signer)} (${short(e.hash)})`));
}

// ---------- task ----------

function taskMain(root, args) {
  const sub = args.shift();
  const { flags: f, rest } = parse(args);
  if (!sub || sub === 'help' || f.help || f.h) { process.stdout.write(TASK_USAGE); return; }
  const dir = R.resolveDir(root, f.dir);
  const showClaim = c => `${c.claim_id}  ${clean(c.task)}  ${c.role}  ${c.status}  ${clean(c.agent)} · ${clean(c.vendor)}${c.branch ? `  branch ${clean(c.branch)}` : ''}  until ${clean(c.expires_at)}`;
  if (sub === 'claim') {
    const r = C.claim(dir, R.identityFrom(f, process.env, root), { task: rest[0], role: f.role, branch: f.branch, ttl: f.ttl, note: f.note });
    out(f, r, () => console.log((r.already_held ? 'already yours: ' : 'claimed: ') + showClaim(r.claim)));
    return;
  }
  if (sub === 'renew') {
    const r = C.renew(dir, R.identityFrom(f, process.env, root), { claim_id: rest[0], ttl: f.ttl });
    out(f, r, () => console.log('renewed: ' + showClaim(r.claim)));
    return;
  }
  if (sub === 'release') {
    const r = C.release(dir, R.identityFrom(f, process.env, root), { claim_id: rest[0], status: f.status, note: f.note });
    out(f, r, () => console.log('ended: ' + showClaim(r.claim)));
    return;
  }
  if (sub === 'list') {
    const s = C.foldClaims(R.load(dir).entries);
    const rows = (f.all ? s.all : s.active).filter(c => !f.task || c.task === f.task);
    out(f, { claims: rows, conflicts: s.conflicts }, () => {
      for (const c of rows) console.log(showClaim(c));
      if (!rows.length) console.log('no claims');
      for (const x of s.conflicts) console.log(`! conflict (${x.kind}) between ${x.first} and ${x.second}: separate clones claimed the same thing; honour ${x.first}`);
    });
    return;
  }
  if (sub === 'check') {
    if (!f.branch || !f.agent) R.fail('usage', 'task check --branch B --agent A [--require]');
    const r = C.checkBranchWriter(R.load(dir).entries, { branch: f.branch, agent: f.agent, require: f.require });
    out(f, r, () => console.log(`${r.ok ? '✓' : '✗'} ${clean(r.reason)}`));
    if (!r.ok) process.exitCode = 1;
    return;
  }
  R.fail('usage', `unknown task command "${clean(sub)}"\n${TASK_USAGE}`);
}

function main(cmd, root, args) {
  try {
    if (cmd === 'record') recordMain(root, [...args]);
    else taskMain(root, [...args]);
  } catch (e) {
    if (!(e instanceof R.RecordError) && !['ENOENT', 'EACCES'].includes(e.code) && !e.status) throw e;
    console.error(`archwhere ${cmd}: ${clean(e.message)}`);
    process.exitCode = e.code === 'usage' ? 2 : 1;
  }
}

module.exports = { main, parse };
