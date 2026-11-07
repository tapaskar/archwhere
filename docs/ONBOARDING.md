# Onboarding flow

![onboarding](img/onboarding.png)

| Stage | Who | Time | What happens |
|---|---|---|---|
| **Discover** | human | min 0 | Launch post / Actions marketplace → README hero + live demo |
| **Try** | human | 1–2 min | `npx archwhere init` → starter model, 3 workflows, printed agent prompt |
| **Map** | *their agent* | 2–15 min | Paste the prompt; the agent surveys the repo, writes the real `architecture.json` + flows, iterates until `archwhere check` is green, commits with `ARCHITECTURE.md` |
| **First signal** | GitHub | next PR | The Action comments the impact table + highlighted map — the "aha" moment, zero extra config |
| **Operate** | human | daily | `archwhere mission` — attention rail, lenses, threads |
| **Close the loop** | human, once | 2–10 min | Pick a listener: Claude (GitHub App + secret) · any agent API (`AGENT_WEBHOOK_URL`) · nothing, if their agent already watches GitHub |
| **Payoff** | both | ongoing | Pin a thread on a component → the agent replies **on the map**, with its PR |
| *Optional* | | | `RUNTIME_URL` lights the Runtime lens · `archwhere ir` renders Archify diagrams · `SKILL.md` goes into the agent's instructions |

**Design notes.** The whole funnel protects one moment: the first PR comment, reached
with nothing but `init` + the agent prompt. The map-writing step — where every
architecture tool historically dies — is delegated to the user's own agent, with
`check` as the objective finish line. Everything after the first signal is opt-in
depth, never a prerequisite.
