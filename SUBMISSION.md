# Blastdoor — submission

**The Agent Harness Hackathon · WeMakeDevs × TrueFoundry · August 2026**

| | |
|---|---|
| **Repo** | https://github.com/mrayhankhan/blastdoor |
| **Live console** | https://blastdoor-tau.vercel.app |
| **Demo video** | *(link on submission)* |
| **Built by** | Rayhankhan Pathan — solo |
| **Licence** | MIT |

---

## The job I gave the agent

Investigate a production incident, find what actually broke, and propose a fix — but never
execute anything irreversible without a human who has been told exactly what they are
authorising.

That second half is the project. The first half is table stakes.

## The problem

Every agent harness has human-in-the-loop approval, and almost all of it renders as:

```
Agent wants to run: rollback_deploy(service="payments-svc", deployId="dep-4c21")
Allow? [y/N]
```

That prompt is a formality. The operator cannot tell from it whether the rollback is safe,
what else it takes down, or whether it can be undone — so they approve, because the agent
sounded confident and the incident is burning. The pause exists; the information does not.

Here is what that specific rollback actually does:

> `dep-4c21` applied a schema migration. Rolling the code back leaves old code running
> against a new schema, and there is no undo. It takes Checkout API and the Edge Gateway
> down with it — about 91,000 requests over the 45-second convergence window. And the
> evidence is entirely correlational: the deploy landed six minutes before the spike, which
> is also true of the other two deploys that afternoon.

None of that is in `[y/N]`. **Blastdoor's thesis is that a pause is only worth having if
the report attached to it is worth reading.**

## What it does

The agent investigates freely with read-only tools and writes code in the sandbox to test
its hypotheses. When it wants to change something, the destructive tool **does not
execute** — it produces a blast-radius report and a pending proposal. The only path to the
production system is `execute_approved_action`, which requires a token a human issued out
of band, bound to a fingerprint of the exact arguments they approved.

The agent cannot break anything by being wrong, confused, or prompt-injected. It can only
ever produce a well-argued request.

## Where TrueForge does the work

Not a wrapper. Each of these is on the critical path, and removing any one of them breaks
the product rather than degrading it.

| Harness feature | How it is used | Why it is load-bearing |
|---|---|---|
| **MCP** | `ops-mcp` serves **12 tools** over streamable HTTP. TrueForge attaches it as a `remote` connector. | The agent's *only* route to the estate. There is no back door. |
| **Sandbox** | The agent writes bisect/replay code against `/api/replay` and runs it. | It is the sole way to produce `causal` evidence. Metrics alone cap confidence below the bar an irreversible action must clear. |
| **Human approval** | Every destructive path terminates in a proposal; `execute_approved_action` is gated by TrueForge *and* by the broker's token. | Defence in depth. The harness pauses on the same call the broker would refuse. |
| **Subagents** | Competing hypotheses are delegated and named; findings carry an `investigator`. | Corroboration from independent investigators **raises the confidence score**; a lone investigator carrying the whole case is reported as a gap. Delegation that is not attributed earns nothing. |
| **Skills** | Two git-backed skills mounted from this repo. | They carry the reasoning discipline — find the origin, classify evidence honestly, treat a rejection as a list of what to observe next. |
| **Deferred tools** | Read-only tools preload; destructive ones stay deferred. | Investigation starts immediately; the dangerous surface is not in context until it is needed. |
| **Sessions** | The broker holds proposals independently of the agent loop. | An approval outlives a reconnect. A proposal made before a refresh is still waiting after it. |

Provisioning is **code, not clicks** — [`scripts/provision.ts`](scripts/provision.ts)
registers the connector, both skills, and the agent against the harness HTTP API, and is
idempotent. A judge can verify the integration by reading it.

## Three ideas I think are actually novel

**Reversibility is a ladder, not a boolean.** Most operations are reversible only within a
window, or reversible apart from the work in flight when they ran. Collapsing that into
yes/no is how operators get surprised. The interesting case — rollback across a schema
migration — is reported as genuinely irreversible, and that is the single most common way a
"safe" rollback makes an incident worse.

**Impact attenuates.** A naive graph traversal concludes "the entire estate is affected" on
every run: true, useless, and it trains operators to skim. A caller with a fallback absorbs
a failure and degrades; one without passes it on. Modelling that is what makes the blast
radius worth reading, and it is why the reports differ from each other.

**The approval token is bound to the arguments.** The usual approval pattern is only as
strong as the description the agent wrote — if it can broaden the action between asking and
acting, the human approved something else. Tokens carry a fingerprint of the approved
arguments, are single-use, and expire after fifteen minutes. The e2e suite proves a token
issued for one proposal cannot be redeemed against another.

## Control and safety, demonstrated not asserted

`npm run e2e` drives the real MCP protocol against the real stack:

```
  ..    12 tools exposed
  PASS  read-only investigation returns the injected symptom
  PASS  proposal created (prop_4e9ec0c6)
  PASS  proposing did NOT execute — the deploy is still live
  PASS  execution without a valid token is refused
  PASS  human approval issued a token
  PASS  a token from another proposal cannot be redeemed
  PASS  approved execution succeeds
  PASS  symptom cleared (checkout-api error rate now 0.4%)
  PASS  an approval token is single use
```

Plus **12 unit tests** on the engine covering attenuation, migration rollback, change
freezes, last-replica restarts, investigator corroboration, and the treatment of unmodelled
tools as irreversible rather than assumed safe.

## The interface

The console is not a form. The blast radius **is** a graph, so it renders as one in WebGL,
and the failure travels along the dependency edges in hop order — payments at 0ms, checkout
at 420ms, the edge gateway at 840ms — because propagation order is the thing a list throws
away.

The interaction I care most about is **hold-to-confirm**: an irreversible action should not
be one click away from a tired person, so commitment accrues over a 1.6s hold and releasing
early cancels. Reversible actions keep a plain click — friction only means something if it
is reserved for what deserves it. Unlike a confirmation dialog it cannot be dismissed
without reading, because the wait *is* the reading time. Reduced-motion strips the
decoration but keeps that delay, since it is a safety mechanism rather than an animation.

Severity uses the reserved status palette and is always paired with a text label, because
warning and serious sit at normal-vision ΔE 13.6 and hue must never carry meaning alone.

## Contributing back

TrueForge 0.1.4 does not start on Windows. I traced it to Kysely's `FileMigrationProvider`
`import()`ing a raw `C:\…` path, which Node's ESM loader rejects — filed upstream as
[#427](https://github.com/truefoundry/trueforge/issues/427). The fix is a four-line `import`
hook, prepared as a branch on my fork, and shipped here as
[`scripts/patch-trueforge.ts`](scripts/patch-trueforge.ts) so a Windows judge can run this
project today. `npm run harness` applies it automatically.

## Honest limitations

- The estate in `packages/target-stack` is synthetic. No real production system, no real
  telemetry, no personal data anywhere in this repo.
- The sandbox needs Linux or a Daytona key — TrueForge's local sandbox provider is
  macOS/Linux only, which the devcontainer works around.
- The public deployment cannot run the estate or broker, so it falls back to a **captured**
  proposal, labelled `demo — no live broker` with a visibly fake token. Ship the whole thing
  locally to see it live.
- Confidence scoring is a deliberately coarse prior, not a measurement. It is calibrated to
  be hard to satisfy with correlational evidence, which is the failure mode that matters.

## Running it

```bash
git clone https://github.com/mrayhankhan/blastdoor && cd blastdoor && npm install
npm run demo        # see the approval cards immediately, no harness or model needed
npm test            # 12 unit tests
```

Full setup, including the harness, is in the [README](README.md).

## AI assistance disclosure

AI assistance was used throughout, as the rules permit — Claude for implementation and
review. The architecture, the safety model, and the design decisions described above are
mine, and I can explain any of them. The bugs recorded in [NOTES.md](NOTES.md) are the real
ones I hit, including two the tests did not catch and three cases where a test expectation
was wrong and the engine was right.
