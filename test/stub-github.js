'use strict';
// A local stand-in for the GitHub REST API, for tests and browser checks. Nothing here reaches GitHub.
const http = require('http');

/** routes: { 'GET /repos/o/r/pulls/5': body | (req, body) => body | { __status, ...} }. Unknown paths answer 404. */
function stubGithub(routes = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const pathOnly = req.url.split('?')[0];
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method, url: req.url, body });
      const route = routes[`${req.method} ${req.url}`] !== undefined ? routes[`${req.method} ${req.url}`] : routes[`${req.method} ${pathOnly}`];
      const out = typeof route === 'function' ? route(req, body) : route;
      if (out === undefined) { res.writeHead(404); res.end('{"message":"Not Found"}'); return; }
      const status = out.__status || 200;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

/** A pull request as the single-PR endpoint returns it. */
function pull(number, over = {}) {
  return {
    number, title: `PR ${number}`, state: 'open', merged: false, draft: false, labels: [], comments: 0, review_comments: 0,
    html_url: `https://example.test/pr/${number}`, mergeable: true, mergeable_state: 'clean',
    created_at: new Date(Date.now() - 2 * 86400000).toISOString(), updated_at: new Date().toISOString(),
    head: { ref: `branch-${number}`, sha: `head${number}` }, base: { ref: 'main', sha: 'base0' }, ...over,
  };
}

/** Routes for one PR: its detail, files, passing checks. Pass overrides to change any of them. */
function pullRoutes(pr, files, { checks = [{ status: 'completed', conclusion: 'success' }], statuses = [] } = {}, repo = '/repos/acme/meridian') {
  return {
    [`GET ${repo}/pulls/${pr.number}`]: pr,
    [`GET ${repo}/pulls/${pr.number}/files`]: files.map(f => (typeof f === 'string' ? { filename: f } : f)),
    [`GET ${repo}/commits/${pr.head.sha}/check-runs`]: { check_runs: checks },
    [`GET ${repo}/commits/${pr.head.sha}/status`]: { statuses },
  };
}

module.exports = { stubGithub, pull, pullRoutes };
