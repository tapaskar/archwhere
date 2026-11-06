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
