'use strict';
// archwhere sign-off: an Ed25519 signature by a human owner over an entry in the record. It is the one
// kind of record that says "a human decided this" with evidence behind it. Its limits are in docs/RECORD.md.
// The MCP server has no tool that reaches this file's signing path.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const R = require('./record');

const DECISIONS = ['approve', 'reject'];
const SIGNERS_FILE = path.join('arch', 'record-signers.json');
const MIN_PASSPHRASE = 12;

const keyIdOf = spkiDer => R.sha256(spkiDer).slice(0, 16);
const defaultKeyPath = (name, home = os.homedir()) => path.join(home, '.config', 'archwhere', `signoff-${name}.pem`);

/** Make a passphrase-protected key outside the repo. Returns the public half to add to the trusted signers. */
function keygen({ name, passphrase, keyPath, root }) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) R.fail('invalid', 'signer names are letters, digits and . _ -');
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) R.fail('invalid', `the passphrase needs at least ${MIN_PASSPHRASE} characters`);
  const file = path.resolve(keyPath || defaultKeyPath(name));
  if (root && R.isInside(R.realish(root), R.realish(file))) R.fail('path', 'refusing to put a signing key inside the repo');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
  });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, privateKey, { mode: 0o600, flag: 'wx' });
  return { name, key_id: keyIdOf(publicKey), public_key: publicKey.toString('base64'), key_path: file };
}

function loadPrivateKey(file, passphrase) {
  const pem = fs.readFileSync(file, 'utf8');
  if (!pem.includes('ENCRYPTED PRIVATE KEY')) R.fail('invalid', `${file} is not passphrase-protected; refusing to sign with it`);
  try { return crypto.createPrivateKey({ key: pem, passphrase }); }
  catch { R.fail('passphrase', 'could not unlock the signing key: wrong passphrase?'); }
  return null;
}

/** Exactly the bytes signed. The hash of the target binds the signature to that entry and all before it. */
function signedBytes({ target, decision, note, signer, key_id, signed_at }) {
  return Buffer.from('archwhere-signoff-v1\n' + R.canonical({ target, decision, note: note || '', signer, key_id, signed_at }), 'utf8');
}

/** Sign a decision on an entry and append it. The caller has the human's passphrase; agents should not. */
function signoff(dir, { target, decision, note, signer, keyPath, passphrase }) {
  if (!DECISIONS.includes(decision)) R.fail('invalid', `decision must be one of ${DECISIONS.join(', ')}`);
  const key = loadPrivateKey(path.resolve(keyPath || defaultKeyPath(signer)), passphrase);
  const spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  const key_id = keyIdOf(spki);
  return R.transact(dir, ctx => {
    const t = R.mustFind(ctx.entries, target, 'target');
    if (!ctx.chainOk) R.fail('tampered', 'refusing to sign: the record does not verify. Run `archwhere record verify`');
    const fields = { target: t.hash, decision, note: note || undefined, signer, key_id, signed_at: new Date().toISOString() };
    const signature = crypto.sign(null, signedBytes(fields), key).toString('base64');
    return ctx.add({ type: 'signoff', attr: { actor: R.HUMAN, author: signer }, ...fields, signature, components: t.components, task: t.task });
  });
}

/**
 * The trusted public keys. Prefers the copy on the default branch, because any agent can edit a working
 * tree; `weak` says when the only source was the working tree. Nothing here makes the default branch safe:
 * that takes branch protection.
 */
function loadSigners(root, { file, ref } = {}) {
  const parse = (text, source, weak) => {
    const d = JSON.parse(text);
    if (!d || !Array.isArray(d.signers)) R.fail('invalid', `${source}: expected { "signers": [...] }`);
    return { signers: d.signers.filter(s => s && s.name && s.public_key), source, weak };
  };
  if (file) return parse(fs.readFileSync(path.resolve(root, file), 'utf8'), file, false);
  const rel = SIGNERS_FILE.split(path.sep).join('/');
  for (const r of ref ? [ref] : ['origin/HEAD', 'origin/main', 'origin/master']) {
    try {
      const text = execFileSync('git', ['show', `${r}:${rel}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return parse(text, `${r}:${rel}`, false);
    } catch { /* try the next */ }
  }
  try { return parse(fs.readFileSync(path.join(root, SIGNERS_FILE), 'utf8'), SIGNERS_FILE + ' (working tree)', true); }
  catch { return { signers: [], source: 'none', weak: true }; }
}

function verifyOne(e, signers) {
  const known = signers.find(s => s.name === e.signer && keyIdOf(Buffer.from(s.public_key, 'base64')) === e.key_id);
  if (!known) return 'unknown-key';
  try {
    const pub = crypto.createPublicKey({ key: Buffer.from(known.public_key, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, signedBytes(e), pub, Buffer.from(String(e.signature), 'base64')) ? 'verified' : 'bad-signature';
  } catch { return 'bad-signature'; }
}

function checkSignoffs(entries, signers) {
  const hashes = new Set(entries.map(e => e.hash));
  return entries.filter(e => e.type === 'signoff').map(e => {
    let status = verifyOne(e, signers);
    if (status === 'verified' && !hashes.has(e.target)) status = 'dangling';
    return {
      hash: e.hash, target: e.target, decision: e.decision, signer: e.signer, key_id: e.key_id,
      signed_at: e.signed_at, status, segment: e.seg, line: e.seq + 1,
    };
  });
}

/**
 * How strong is the claim about who made this entry, and has an owner signed it?
 * made_by: agent (declared) | human-unsigned (says it's a human; anyone could type that)
 *   | human-signed (a sign-off with a verified signature) | human-unverified (a sign-off that doesn't verify).
 * signed_by: verified owner sign-offs that target this entry.
 */
function whoMade(entry, signoffs = []) {
  const own = signoffs.find(s => s.hash === entry.hash);
  const made_by = own ? (own.status === 'verified' ? 'human-signed' : 'human-unverified')
    : (entry.actor === R.HUMAN ? 'human-unsigned' : 'agent');
  const signed_by = signoffs.filter(s => s.target === entry.hash && s.status === 'verified')
    .map(s => ({ signer: s.signer, decision: s.decision, signed_at: s.signed_at }));
  return signed_by.length ? { made_by, signed_by } : { made_by };
}

module.exports = { DECISIONS, SIGNERS_FILE, MIN_PASSPHRASE, keyIdOf, defaultKeyPath, keygen, signoff, signedBytes, loadSigners, checkSignoffs, whoMade };
