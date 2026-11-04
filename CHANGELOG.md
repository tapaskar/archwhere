# Changelog

## Unreleased

### Added
- **`archwhere mcp`**: an MCP server on stdio, hand-written JSON-RPC with no dependencies. It serves protocol 2026-07-28
  and the older `initialize` handshake. Read-only by default, with write tools only under `--write` and a declared
  identity. There is no merge, shell or sign-off tool. Output is marked as untrusted data. See `docs/MCP.md`.
- **`archwhere record`**: an append-only, hash-linked, attributed log of specs, decisions, findings, corrections,
  reviews and owner sign-offs. One JSONL segment per clone under `.archwhere/record/`, not committed by default, with
  full export and import. Tamper-evident, not tamper-proof. See `docs/RECORD.md`.
- **Specs**: stored word for word, addressed by SHA-256, versioned by linking, and tied to components.
- **`archwhere task`**: atomic claims with roles, expiry and one writer per branch, on one filesystem.
- **`record independent`**: checks that a different vendor and model approved the work, using self-declared data.
- **`record signoff`**: an Ed25519 owner sign-off, with a passphrase from the terminal only.
- **`record anchor`**: publishes the head hash in a git tag or GitHub comment, and `record verify` checks it.
- **Record lens** in mission control and `GET /api/record`, both read-only.
### Security
- The example Kiro agent could read any file the user can, because pre-approving a tool skips its
  path limits. It's now limited to the working directory; re-copy it, and drop `--trust-tools` from
  your bridge `--cmd`.
- **Mission control ran PR titles and branch names as HTML.** On a public repo, anyone who could open
  a PR could run script in the page that holds the Merge button. All GitHub and model text is now
  escaped.
- **Another website could POST to `/api/merge`** on localhost and merge with your token. Writes now
  need a JSON content type and a matching Origin, and every route needs a loopback Host.

### Added
- **Merge recheck.** `POST /api/merge` asks GitHub again at the click: same head commit as shown,
  checks and commit statuses green, no conflict, not a draft. It then merges pinned to that commit, so
  GitHub refuses if the head moves in between. It now requires `sha`.
- **Security PRs can merge from the rail** once green, by typing the PR number. The server enforces it.
- **`archwhere check --base REF [--labels a,b]`** compares the model with the base. It reports a
  security component removed or reclassified, a watch pattern removed or edited, a file moved out of a
  zone by a glob, and a moved model. These fail, as does changing a security component or firing a
  watch pattern, or editing a workflow or CODEOWNERS, without the `owner-review` label. Labels also
  come from `ARCHWHERE_PR_LABELS`. With no labels given it only reports.
- **`enforce` input on the Action**, off by default. It runs that check on the PR. `archwhere init`
  turns it on and adds the `labeled` and `unlabeled` triggers it needs.
- **The PR comment says loudly when a PR weakens the map**, and flags now come from both the base and
  the PR's model, so editing the map can't hide the same change.
- **Rail reasons.** Each item says why it sits where it does, its age and idle time, and which open PRs
  overlap it. `staleDays` in `mission.config.json` (default 14) moves idle PRs out of "ready".
- `check` notes relative JS/TS imports between components that `deps` doesn't declare. It doesn't fail.
- `check` names the missing component in a flow step, and fails on an unknown lane entry or a watch
  pattern that isn't a valid regex.

### Fixed
- **Conflicted PRs showed as ready to merge.** GitHub's list endpoint has no `mergeable` field, so the
  conflict test never fired. Mission control now reads each PR, and a PR GitHub hasn't assessed is not
  called ready. Comment counts on PRs were missing for the same reason.
- `action_required`, `startup_failure` and `stale` checks counted as green. Only `success`, `neutral`
  and `skipped` do now, and commit statuses count as well as check runs.
- Only a PR's first 100 files were read, and a rename only by its new name, so a security change could
  go unseen. All pages and both names are read now, by `map --base` too. A failed read no longer looks
  like an empty PR.
- PRs with files off the map no longer show as ready, and the rail says when more than 20 PRs are open.
- The component card showed `[object Object]` for watch patterns.
- Watch patterns fired on filenames and unchanged neighbouring lines. They now read only the lines a
  change adds or removes.
- The README told you to run `npx archwhere`, which fails because the package isn't on npm.

## 1.0.0 — 2026-11-04

The first major release. The CLI commands, the `architecture.json` model and the GitHub Action
inputs are now stable: from here, a breaking change to any of them means a new major version.
Nothing breaks when upgrading from 0.3.0.

### Added
- **System flow lens** in mission control: the Mermaid system map, with components that have an
  open PR highlighted, and every process flow as a sequence diagram, in the same page as the
  attention rail. Mermaid 11.4.1 loads from jsDelivr only when the lens opens, pinned by SHA-384,
  in strict mode. Needs network access for that one file.
- `GET /api/system-flow`, read-only. It still answers without GitHub, with no PRs highlighted.
- `flowDiagram()` and `systemFlow()` in `lib/where.js`, `touchedComponents()` in `lib/rail.js`.

## 0.3.0 — 2026-11-03

### Added
- **Several agents on the board.** Configure them with `AGENT_MENTIONS="Claude=@claude,Kiro=@kiro"`
  or `agents: [{ name, mention }]` in `arch/mission.config.json`. `/api/model` now returns `agents`.
  `AGENT_MENTION` and `agentMention` still work as the single default agent.
- **Ask: selector** in mission control, next to Send: each agent, plus Both or All. It remembers
  the last choice and is hidden when there is only one agent.
- **A typed mention wins.** If a message already names any known agent, nothing is appended.
- **Reply tags.** Thread messages show which agent replied: a bot login, or the bridge header.
- **`archwhere bridge`** (`lib/bridge.js`) lets a local CLI agent such as `kiro-cli` answer board
  threads. It has an allow-list (repo owner plus `--allow`; bots and its own replies are ignored),
  runs one job at a time, keeps a persisted cursor and seen-set, uses `execFile` with an argument
  array, enforces a timeout, strips ANSI codes, caps replies at about 60k characters, posts a note
  on failure, and supports `--once`. It refuses `--trust-all-tools`.
- `examples/kiro/archwhere-readonly.json`: a Kiro agent config that exposes only `fs_read`.

### Changed
- The GitHub client moved into `lib/gh.js`, shared by mission control and the bridge. Behaviour is
  unchanged: `GITHUB_TOKEN`, else `gh auth token`, and `GITHUB_API` overrides the base URL.

## 0.2.1
- Live thread replies and a component details card in mission control.

## 0.2.0
- `init --infer`, `check --fix` with patch suggestions, and the change-heat lens.
