# The MCP server

`archwhere mcp` lets any MCP client read the map, the attention rail, threads and the record, and with `--write`,
add to the record. It runs on stdio, in hand-written JSON-RPC, with no dependencies.

**Read-only by default.** Write tools don't exist unless the server starts with `--write`, which also requires an
identity. **There is no merge tool and no shell tool, and there won't be.** Merging stays with the owner, in mission
control or on GitHub. No tool signs off either: see [RECORD.md](RECORD.md#who-made-a-decision).

## Protocol

The server is dual-era. It implements the current revision, **2026-07-28** (stateless: `_meta` on every request,
`server/discover`, `resultType`, cache hints, `subscriptions/listen`, no handshake and no `ping`), and also the older
`initialize` handshake for clients on **2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05**, because many clients
still use it. `ping` is answered for those older clients. Batches are accepted only under 2025-03-26, the one revision
that had them. An unsupported version gets `-32022`, as the specification says.

## Tools

| Read (always) | |
|---|---|
| `get_map`, `get_component`, `get_flows` | The declared architecture, with each component's specs and claims |
| `what_touches` | Files, a diff, a git base or the working tree mapped to components, with flags |
| `get_rail`, `list_threads`, `get_thread` | Attention rail and threads. These need GitHub |
| `record_get`, `record_search`, `record_export`, `record_verify` | The record |
| `get_spec`, `list_claims`, `check_independent` | Specs word for word, who holds what, the review check |

| Write (with `--write`) | |
|---|---|
| `put_spec`, `put_finding`, `put_decision`, `put_correction`, `put_review`, `put_work` | Append to the record |
| `claim_task`, `renew_claim`, `release_claim` | Atomic task claims |
| `ask_human` | One question, as a `needs-owner` issue that shows under Blocked. Needs a GitHub token |

## Safety

- **Untrusted data is marked.** Every result sits inside `<untrusted-data source="…">` markers, with a line telling the
  reader not to follow instructions in it, and `_meta["dev.archwhere/untrusted"]` carries the source. Content is JSON
  with `<`, control, bidi and invisible characters written as `\uXXXX`, so hostile text can't close the marker or hide
  from a reader, and parsing it gives back the original word for word. Marking helps a careful client and model; it
  can't guarantee that a model ignores an injected instruction. `get_thread` includes `author_association`: anyone can
  write on a public repo.
- **Identity is fixed at launch.** `--author --agent --model --vendor` (or the `ARCHWHERE_*` variables) apply to every
  write. Tool arguments can't change them, so a prompt-injected agent can't attribute a write to someone else through
  this server. They are still self-declared by whoever wrote the config.
- **Tokens stay out.** The token comes from `GITHUB_TOKEN` or `gh auth token` and is used only for GitHub calls. Output
  and errors are scrubbed for it and for token shapes.
- **Paths stay in the repo.** `what_touches` rejects absolute paths, `..` and anything a symlink takes outside. Git refs
  must be plain, so none can become a git option. No tool takes a file or directory to read: the record dir, repo root
  and model are set at launch. A default record dir that a symlink aims outside the repo stops the server starting.
- **Bounded.** Messages over 2 MiB are refused. Results stay near 256 KiB and say so when trimmed. Long specs and bodies
  come in pages (`next_offset`), the export in pages (`next_cursor`), and the largest spec reassembles exactly. An entry
  too big for an export page is listed under `omitted`; read it with `record_get`. Tool calls are limited to 600 a minute
  and writes to 60 a minute, per process.
- **Offline.** GitHub tools return a clear tool error after at most 15 seconds, and the map and record tools keep working.
- `ask_human` breaks `@mentions` so a question can't summon an agent or ping anyone, and it refuses anything but one
  question on one line. Put background in `context`.

## Setup

Read-only first. To write, add `--write --author NAME --agent NAME --model MODEL --vendor VENDOR` to the arguments.
The examples run it from the npm registry with `npx -y archwhere`. The first run downloads it, which can outlast a
client's connect timeout: `node /path/to/archwhere/bin/archwhere.js mcp` from a checkout avoids that, and pins what
you run. `npx -y archwhere@1.0.5` pins the version without a checkout.
Each agent should have its own identity, or claims can't tell agents apart.

### Claude Code

```bash
claude mcp add --transport stdio archwhere -- npx -y archwhere mcp
```

Or in `.mcp.json` at the repo root:

```json
{ "mcpServers": { "archwhere": { "command": "npx", "args": ["-y", "archwhere", "mcp"] } } }
```

Tested: Claude Code 2.1.318 connected, listed the tools and called `get_map`, both on protocol 2026-07-28 and with
`MCP_PROTOCOL_NEGOTIATION=legacy`. That run used `--mcp-config` and a checkout path rather than `npx`.

### Kiro

`.kiro/settings/mcp.json` in the workspace, or `~/.kiro/settings/mcp.json`:

```json
{ "mcpServers": { "archwhere": { "command": "npx", "args": ["-y", "archwhere", "mcp"] } } }
```

Tested: kiro-cli 2.28.0 connected over the `initialize` handshake (protocol 2025-11-25) and called `get_map`. Tested from
a workspace config with a checkout path, in the CLI only; the Kiro IDE was not tried. The bridge's read-only Kiro agent
is a different thing: it allows no MCP.

### Hermes

`~/.hermes/config.yaml`:

```yaml
mcp_servers:
  archwhere:
    command: npx
    args: ["-y", "archwhere", "mcp", "--root", "/path/to/repo"]
    env:
      GITHUB_TOKEN: "..."
```

Tested: Hermes 0.21.5 (`hermes mcp test`, with a temporary `HERMES_HOME` and a checkout path) connected over the `initialize`
handshake (protocol 2025-11-25) and discovered the tools. It was not run with a model calling a tool.

Hermes passes only configured `env` plus a safe baseline to a server, so give `GITHUB_TOKEN` there if you need the GitHub
tools. Its working directory defaults to the session's or the Hermes process's, hence `--root`.

## Limits

Tool results carry no `structuredContent`, because the marker is the point and it has to wrap everything. There are no
resources or prompts. Over stdio, record locks are taken synchronously: a blocked lock can hold up other requests on that
server for up to 15 seconds. HTTP transport isn't implemented.
