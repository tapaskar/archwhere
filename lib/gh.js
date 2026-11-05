'use strict';
// Tiny GitHub REST client shared by mission control and the bridge. Zero dependencies.

const { execFileSync } = require('child_process');

/** GITHUB_TOKEN, else `gh auth token`, else '' (anonymous, read-only, low rate limit). */
function githubToken(env = process.env) {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

/**
 * { owner, repo } from the git "origin" remote of cwd.
 * Throws a message meant to be printed as-is: a missing repo or remote is the user's
 * situation to fix, not a stack trace (`npx archwhere mission` outside a clone hit one).
 */
function originRepo(cwd, parse) {
  let url;
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    throw new Error(`no git "origin" remote in ${cwd}\n`
      + 'archwhere reads the repo from it. Run this inside a clone with a GitHub origin, '
      + 'or pass --repo owner/name.');
  }
  return parse(url);
}

/** API base: env GITHUB_API (handy for GHE or a local stub), else api.github.com. */
function apiBase(env = process.env) {
  return (env.GITHUB_API || 'https://api.github.com').replace(/\/$/, '');
}

/** gh(urlOrPath, fetchOpts) -> parsed JSON; throws "GitHub <status> on <path>: …" on non-2xx. */
function makeGh({ base = apiBase(), token = '', fetchImpl = fetch } = {}) {
  return async function gh(url, o = {}) {
    const full = url.startsWith('http') ? url : base + url;
    const res = await fetchImpl(full, {
      ...o,
      headers: {
        'Accept': 'application/vnd.github+json', 'User-Agent': 'archwhere',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...(o.body ? { 'Content-Type': 'application/json' } : {}), ...(o.headers || {})
      }
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub ${res.status} on ${full.replace(base, '')}: ${text.slice(0, 200)}`);
    }
    return res.json();
  };
}

module.exports = { githubToken, apiBase, makeGh, originRepo };
