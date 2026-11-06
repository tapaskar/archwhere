# The attributed record

A shared memory for several agents and their owner: an append-only log of specs, decisions, findings,
corrections, reviews, claims and owner sign-offs. Every entry names its author, agent, model and vendor.
GitHub stays the conversation bus. The record holds what has to outlast a conversation.

```bash
export ARCHWHERE_AUTHOR=dana ARCHWHERE_AGENT=builder-1 ARCHWHERE_MODEL_ID=claude-sonnet ARCHWHERE_VENDOR=anthropic

archwhere record spec put ticket-sla --file specs/sla.md --components ticket-engine --task T-12
archwhere task claim T-12 --role builder --branch feat/sla --ttl 30m
archwhere record put finding --title "SLA clock ignores holidays" --components ticket-engine --task T-12
archwhere record put work --task T-12 --branch feat/sla --commit abc1234
archwhere record search holidays --component ticket-engine
archwhere record verify
```

`archwhere record help` and `archwhere task help` list everything. `ARCHWHERE_MODEL_ID`, not
`ARCHWHERE_MODEL`, because that name already points at the architecture file.

## Where it lives, and whether to commit it

The default is `.archwhere/record/` in the **main** worktree, so agents in separate `git worktree`s share
one record and one lock. Change it with `--dir` or `ARCHWHERE_RECORD_DIR`.

**It is not committed by default.** A nested `.gitignore` containing `*` keeps it out of git. Specs,
findings and decisions can hold customer names, vulnerabilities and internal plans, and in a public repo a
commit is publication that can't be taken back. To opt in, run `archwhere record init --commit` and read
this first:

- Everything in the record becomes as public as the repo.
- An append-only log has no delete. Entries that look like credentials are refused on the way in, by
  pattern matching, which catches common token shapes and nothing else. Removing an entry later means
  rewriting the chain, and `record verify` will then rightly fail against any earlier anchor.

## Files and format

| File | |
|---|---|
| `log-<segment>.jsonl` | The entries. One segment per clone, one JSON object a line, keys sorted. |
| `.local-segment` | This clone's segment id. Never committed. |
| `.local-head.json` | The witness: the newest position seen in each segment. Never committed. |
| `.lock` | Held for the moment of an append. Never committed. |

An entry's `hash` is the SHA-256 of its canonical form, and that form includes `prev`, the hash of the entry
before. The first entry's `prev` is derived from the segment id.

## Concurrent writers and merge conflicts

**On one filesystem** every append takes an exclusive lock file (`O_EXCL`), reads the current state, checks
and appends, then releases. That covers processes, and worktrees sharing the default dir. A lock left by a
dead process on the same host is broken; a live holder is waited for (15 seconds, then a clear error) and is
only given up on after 10 minutes. The test suite runs 8 processes writing 200 entries and 10 processes
racing for one claim. Network filesystems are untested.

**Across clones there is no shared lock, and no merge conflicts either**, because each clone only ever
appends to its own segment file. If you commit the record, git merges by adding files. Without committing:
`record export` on one side and `record import` on the other. A segment that has really forked (two copies of
one segment id with different entries) is refused rather than overwritten. Order inside a segment is proved
by the chain. Order between segments comes from each writer's declared clock, so it is a best effort.

## Specs

- **Word for word.** The text is stored as given, down to line endings, and hashed as UTF-8. Text that can't
  round-trip through UTF-8 is refused rather than altered.
- **Content-addressed.** `record spec get --sha256 <hash>`, or `--raw` for the exact bytes.
- **Versioned, never edited.** Changed text becomes a new entry whose `supersedes` names the previous hash.
  Storing identical text again writes nothing. Pass `--supersedes` to fail if someone else changed it first.
  If separate clones both change a spec, `record spec list` reports it as forked.
- **Tied to components**, checked against the map, and inherited by later versions unless they say otherwise.

"Immutable" has an exact meaning here: no command or tool edits a spec, and `record verify` detects any edit
of the file. The file itself is still a file, and someone with disk access can change it.

## Claims

`task claim` takes a role (`builder`, `reviewer`, `tester`) on a task, atomically.

- One holder per role on a task. Split work into several task ids to have several builders.
- One writer per branch: a builder or tester naming a branch holds it across all tasks. Reviewers don't.
- A task's builder can't also be its reviewer.
- A claim expires (default 30 minutes, at most 24 hours) unless renewed. Once it has expired, someone else can
  take over and the old holder can't renew it.
- The same rules are applied when the log is **read**, not only when it is written, because an imported
  segment can carry entries no local command checked. An update whose declared writer is not the holder is
  refused, and so is a renewal reaching more than one ttl past the moment it was written. Both are listed
  under the claim's `rejected`, never silently dropped. An `expires_at` that cannot be parsed counts as
  expired rather than as never expiring.
- Status: `active`, `expired`, `done`, `released`, `failed`.

**Limits.** Claims are advisory: they coordinate agents that check them, and nothing stops a process from
ignoring them and pushing. `archwhere task check --branch B --agent A` exits 1 when someone else holds the
branch, for use in a pre-push hook, which a determined process could also skip. Holder names are
self-declared. Atomicity holds **on one filesystem**: claims made on separate clones can collide, and the
collision shows up in `task list` after an import, with the earlier claim to honour. It is detected, not
prevented. Expiry trusts the local clock.

## Who made a decision

| `made_by` | What it means | How strong |
|---|---|---|
| `agent` | An agent recorded this. | Declared. |
| `human-unsigned` | Someone passed `--human`. | A claim. Anyone with a shell can type it. |
| `human-signed` | An owner sign-off whose signature verifies against a trusted key. | Cryptographic, within the limits below. |
| `human-unverified` | A sign-off whose key isn't trusted. | Treat as forged. |

`signed_by` on any entry lists the verified sign-offs that target it.

```bash
archwhere record keygen --signer dana --add     # writes arch/record-signers.json; merge that to the default branch
archwhere record signoff --target <hash> --decision approve --signer dana --note "agreed"
```

The key is Ed25519, passphrase-protected, stored outside the repo, and refused if unprotected. The command
reads the passphrase from the controlling terminal only and shows the entry being signed, cleaned of control
characters. The MCP server has no path to any of this: it records `actor: agent` from an identity fixed at
launch, and a tool call can't change that.

**An agent can't forge a sign-off, provided all of these hold:**

1. It can't get the private key **and** the passphrase. An agent under the owner's account can read the key
   file, so the passphrase is what's left. A keylogger, a shared terminal or a passphrase kept in a script ends
   that. A separate machine or OS account for the key is stronger.
2. It can't change the trust list. `verify` reads `arch/record-signers.json` from `origin/HEAD` (then
   `origin/main`, `origin/master`), and says when it could only find a working-tree copy, which is weak. Without
   branch protection, an agent that can push to the default branch can add its own key. An agent with the owner's
   GitHub token is that agent.
3. The owner reads what they sign. A signature proves the key was used on that entry, not that the entry is
   wise or that the owner understood it.

Replaying a sign-off on another entry fails, because the target's hash is signed. Copying one to the same entry
says nothing new. There is no key revocation beyond removing a key from the list, which makes its old signatures
show as unverified too.

## Independent review

```bash
archwhere record put review --task T-12 --verdict approve --commit abc1234   # as the reviewer
archwhere record independent --task T-12 [--commit abc1234]                  # exit 0 or 1
```

It passes when an `approve` review comes from a different vendor **and** a different model than every author
(builder claims and `work` entries on the task, or the target entry's author). A review followed by newer work
is stale and doesn't count. Vendor means who made the model, not who hosted it: a model name that gives away
its maker overrides the declared vendor, so `us.anthropic.claude-…` with vendor `aws` compares as Anthropic.

**Vendor and model are self-declared.** The check confirms what was recorded, not what ran. It catches honest
mistakes and misrouted reviews. It can't catch an agent that lies. A model name archwhere doesn't recognise is
compared by its declared vendor alone. A `human` reviewer is unverified unless a sign-off covers the entry.

archwhere does not make agents review each other. This records and checks the step; driving it is a later stage.

## What `record verify` proves

| Change | Detected by | |
|---|---|---|
| Edit an entry, even whitespace | the chain | always |
| Edit and recompute that entry's hash | the next entry's `prev` | unless it was the newest entry; then the witness |
| Delete, insert, duplicate or reorder inside a segment, leaving later hashes alone | the chain | always |
| Change a spec and recompute that entry's hash | the spec's `sha256`, and the next entry's `prev` | as above |
| Delete the newest entries | **only** the witness or an anchor | no link breaks |
| Delete a whole segment | **only** the witness or an anchor | |
| Rewrite from any entry to the end with every hash recomputed, witness included | **only** an anchor kept elsewhere | |
| Delete everything | **only** an anchor | |

So this makes tampering **evident**. It does not prevent it, and on its own it can't catch someone who rewrites
the whole chain, because the witness lives in the same directory and is only a check against accidents and careless
edits. Timestamps are the writer's own clock and prove nothing about when something really happened.

### Anchors

```bash
archwhere record anchor --tag --push     # an annotated git tag on the remote
archwhere record anchor --issue 42       # a comment on a GitHub issue or PR
archwhere record verify --issue 42       # local anchor tags are always checked
```

An anchor publishes only hashes and positions, no record content. It adds a copy of the head held somewhere the
record's writer doesn't control: entries up to that point can no longer be rewritten without `verify` noticing,
as long as the anchor survives. It adds a rough date through GitHub. It doesn't protect anything written after
it, or help if whoever rewrites the record can also delete the tag or comment, so someone with admin rights on
the repo can defeat it. Only comments from repo members count. `git fetch --tags` brings in tags from elsewhere,
and `verify` then fails if it lacks an anchored segment: import that clone's record, or delete the tag.

`record verify --strict` also fails on any warning, unverified sign-off, weak trust list or missing anchor.

## Portability

`archwhere record export --out record.jsonl` writes a header plus every line verbatim. It is plain JSONL with a
documented hash rule, so it can be checked anywhere, and `record import` restores it. It holds everything, so it
is written with mode 600.
