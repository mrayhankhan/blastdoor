---
name: blastdoor
description: Working state and handoff for Blastdoor — the incident-response agent on TrueForge built for the WeMakeDevs Agent Harness Hackathon (deadline Aug 30 2026, 8pm SF). Use this whenever the task touches this repo: bringing the stack up, wiring or debugging TrueForge, running the demo, recording the video, Qodo/PR work, the blog post, deploying, or deciding what to do next with the time left. Also use it when the user says "the hackathon project", "blastdoor", "the agent", or asks what is left to do. It carries the machine-specific setup (this project moved from Windows to macOS), the exact bring-up commands, and the current state of every deliverable.
---

# Blastdoor — project handoff

An incident-response agent on TrueForge whose thesis is that **a human-in-the-loop pause is
only worth having if the report attached to it is worth reading**. The agent investigates
freely, but destructive tools do not execute — they emit a blast-radius report and a pending
proposal, and the only route to production requires a token a human issued out of band,
bound to a fingerprint of the exact arguments approved.

| | |
|---|---|
| Repo | https://github.com/mrayhankhan/blastdoor (public, MIT) |
| Live console | https://blastdoor-tau.vercel.app |
| Open PR | https://github.com/mrayhankhan/blastdoor/pull/1 |
| Deadline | **Aug 30 2026, 8:00 PM San Francisco** = Aug 31 03:00 UTC |
| Author | Rayhankhan Pathan, solo |

Read `references/architecture.md` for how the pieces fit and why. Read
`references/decisions.md` for the bugs found and the reasoning behind the non-obvious
choices — it is also the raw material for the blog post.

## Machine note: this moved from Windows to macOS

Two Windows-specific problems **disappear on macOS**, and one script becomes a no-op.

- **TrueForge 0.1.4 does not start on Windows** — upstream
  [#427](https://github.com/truefoundry/trueforge/issues/427). Kysely's
  `FileMigrationProvider` joins the migrations folder and filename into an OS path and
  `import()`s it; on Windows that is `C:\…`, which Node's ESM loader rejects. On macOS the
  joined path resolves and the harness starts normally. `scripts/patch-trueforge.ts` detects
  non-Windows and exits without touching anything, so `npm run harness` just works.
- **The local sandbox provider is macOS/Linux only.** On Windows the harness logged
  `Local sandbox fallback is unavailable (LocalSandboxProvider supports macOS and Linux
  only, got win32)` and its provider catalog offered nothing but `daytona`. On macOS that
  fallback should be available, which would remove the need for a Daytona account —
  **verify this first on the Mac** by checking Settings → Sandbox, or
  `curl localhost:8790/api/v1/catalogs/sandbox-providers`. If a local option appears, use
  it. If only `daytona` appears, a free Daytona key is still needed.
- A branch fixing #427 upstream is pushed to the fork `mrayhankhan/trueforge`, branch
  `fix/windows-migration-esm-url`. The PR was deliberately not opened, because #427 is
  already assigned to another contributor and that is a courtesy call for the user to make.

## Bring the stack up (macOS)

Requires **Node 22+**. TypeScript runs directly — there is no build step anywhere.

```bash
git clone https://github.com/mrayhankhan/blastdoor && cd blastdoor && npm install
```

Four terminals:

```bash
npm run stack        # the estate                  :4000
npm run mcp          # MCP over HTTP + broker      :4300 / :4200
npm run console      # the approval console        :4100
npm run harness      # TrueForge                   :8790
```

Then, once, in the TrueForge UI at http://localhost:8790:

1. **Settings → Models** — add a provider API key. Nine providers are supported
   (`openai`, `anthropic`, `google-gemini`, `fireworks`, `zai`, `moonshot`, `together`,
   `alibaba`, `custom`). `agent/agent.json` pins `anthropic/claude-opus-5`; change that one
   line if using a different provider.
2. **Settings → Sandbox** — enable the local provider if macOS offers one (see the machine
   note above); otherwise add a free Daytona key. The agent investigates and proposes
   without a sandbox, but cannot run the replay that produces causal evidence.

Then:

```bash
npm run provision    # registers connector + both skills + the agent, idempotent
```

Verify anything:

```bash
npm test             # 12 unit tests on the engine
npm run e2e          # 9 end-to-end safety assertions over real MCP
npm run demo         # renders the three approval cards, no harness or model needed
```

`npm run e2e` runs on its own broker port (default 4210, override with `BROKER_PORT`) so it
coexists with a running `npm run mcp`.

## State of every deliverable

**Done and verified:**

- Core engine, MCP server, target stack, console — 12 unit tests, 9 e2e assertions green,
  verified from a fresh clone.
- TrueForge integration: connector registered over HTTP, **all 12 tools discovered**, both
  skills mounted from the repo, agent spec written, provisioning scripted and idempotent.
- Deployed console with a labelled demo-mode fallback.
- `SUBMISSION.md` (the judged write-up) — on `main`.
- `DEMO.md` (timed shot list) and `BLOG.md` (retrospective) — on the PR branch only.

**Not done — these are what remain:**

1. **No TrueForge session has ever run.** Everything is wired but no model has driven the
   tools. This is the single largest risk: "Use of TrueForge" is 1/6 of the score and the
   rules require judges to see the harness doing work. Needs the model key, then a session.
2. **No demo video.** Mandatory — without it the submission is not judged.
3. **Qodo not installed.** PR #1 was reviewed by *cubic*, not Qodo. Qodo is **required** to
   win Best Code Quality. The repo is owned by a **User account, not an org**, so no org
   admin is needed — install on the personal account `mrayhankhan` and grant access to
   `blastdoor`.
4. **PR #1 unmerged.** It is `MERGEABLE`/`CLEAN` with nothing blocking; it was left open on
   purpose so a reviewer would run against a real PR. Merge after Qodo reviews:
   `gh pr merge 1 --squash --delete-branch`.
5. **Blog post unpublished.** `BLOG.md` is written and needs a public home plus a link in
   the submission.

## Priority with the time remaining

Roughly 21 hours were left as of the handoff. In order:

| # | Task | Est. | Why it ranks here |
|---|---|---|---|
| 1 | Install Qodo → push to PR #1 | 10m | Pure eligibility gate, trivially cheap |
| 2 | Model key → `npm run provision` → run one real session | 1–2h | Biggest score risk, only remaining unknown |
| 3 | Record the video using `DEMO.md` | 1h | Mandatory deliverable |
| 4 | Merge PR #1 | 5m | Puts DEMO/BLOG on `main` |
| 5 | Publish `BLOG.md`, add the link | 20m | Separate stackable prize |
| 6 | Submit | 15m | — |

If time runs short, **cut 5, never 2 or 3.** Submitting for **Best Use of TrueForge**; Best
UI is the fallback track. A team may win only one judged track.

## Recording the demo

`DEMO.md` is a timed shot list, and `scripts/demo-drive.ts` runs the story against the real
MCP server and broker. **Scenes advance on Enter, not on a timer** — the driver prints what
it is waiting for, so the terminal can never race ahead of the narration. Rehearse with
`node scripts/demo-drive.ts --fast`.

The arc is one incident throughout:

1. Payment-failures alert; the error gradient points back to `payments-svc`.
2. The agent proposes rolling back `dep-4c21` on timing alone → **DO NOT RUN**, irreversible
   (schema migration), confidence 28/100. *This is the moment the project rests on — do not
   rush it.*
3. Sandbox replay: `dep-4c21 → FAIL`, `dep-3b90 → PASS`. Causal evidence.
4. The **same** action re-proposed → 91/100, but still irreversible, so the verdict is
   "proceed with care".
5. Because it is irreversible the console demands a **hold**, not a click. Release early
   once on camera to show the cancel.

## Working on this codebase

- TypeScript runs directly under Node 22+. Do not add a build step; the zero-build property
  is deliberate so a judge can clone and run.
- The engine (`packages/blastdoor-core`) is pure and has no I/O. Keep it that way — it is
  the only part that is exhaustively unit-tested.
- **Make every harness feature change an outcome, or it is decoration.** Subagent
  corroboration raises the confidence score; a lone investigator is reported as a gap.
  Sandbox replay is the only way to produce causal evidence, and causal evidence is the only
  thing that clears the bar for an irreversible action. This is the project's central
  design rule and new work should follow it.
- Severity always pairs colour with a text label. The reserved status palette puts warning
  and serious at normal-vision ΔE 13.6, so hue must never carry meaning alone.
- Open a PR for meaningful work rather than pushing to `main`, so Qodo can review it.

## Things that will bite

- Two brokers on one port would split-brain the agent and the console; the broker refuses to
  start on a clash rather than degrade. If a port is held, kill the stale process.
- The console polls the broker. With no broker reachable it falls back to a **captured**
  proposal labelled `demo — no live broker` — that is the deployed behaviour, and it must
  never be presented as live data.
- `agent/agent.json` pins a model FQN. A wrong or unconfigured provider fails provisioning
  with `Unknown model … provider not configured`, which is the expected message before a key
  is added.
