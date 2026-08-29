# I built an agent that can't do anything

*Nine days on TrueForge, building the approval gate instead of the agent.*

---

Every agent framework ships human-in-the-loop approval. Almost all of it renders like this:

```
Agent wants to run: rollback_deploy(service="payments-svc", deployId="dep-4c21")
Allow? [y/N]
```

I stared at that prompt for a while at the start of the WeMakeDevs Agent Harness Hackathon
and realised it is theatre. Not because pausing is wrong — pausing is exactly right — but
because the prompt hands the operator nothing they did not already have. They cannot tell
from it whether the rollback is safe, what else it takes down, or whether it can be undone.
So they type `y`, because the agent sounded confident and the incident is burning.

Here is what that specific rollback actually does:

> `dep-4c21` applied a schema migration. Rolling the code back leaves old code running
> against a new schema, and there is no undo. It takes Checkout API and the Edge Gateway
> down with it — about 91,000 requests over the 45-second convergence window. And the
> evidence is entirely correlational: the deploy landed six minutes before the spike, which
> is also true of the other two deploys that afternoon.

So I did not build an incident-response agent. I built the thing that decides whether to let
one act, and I called it **Blastdoor**.

The agent investigates freely and writes code in the sandbox. When it wants to change
something, the destructive tool **does not execute** — it emits a blast-radius report and a
pending proposal. The only route to production is `execute_approved_action`, which needs a
token a human issued out of band. The agent cannot break anything by being wrong. It can
only ever produce a well-argued request.

Here is what I got wrong on the way.

## Reversibility is not a boolean

My first type was `reversible: boolean`. It survived about an hour.

Rolling back a deploy that carried a schema migration is not reversible — the code goes
back, the schema does not. But it is also not the same species of irreversible as dropping a
table. And a rollback onto a deploy whose build artifact has been evicted is reversible, but
only if you rebuild first.

I ended up with a four-state ladder: `reversible`, `reversible-within-window`,
`reversible-with-loss`, `irreversible`. The whole design got better the moment the type
stopped lying, because every downstream decision — the verdict, the confidence bar, whether
the UI demands a hold — could finally ask a question the type could answer.

The console shows all four rungs with one lit. "Irreversible" means more when you can see
the three safer states it is not.

## A correct graph traversal that was completely useless

The blast radius is a dependency graph, so version one walked it and reported everything
reachable. On every input it concluded that the entire estate was affected.

Which is true! In a connected graph it is always true. It is also worthless, and worse than
worthless, because a report that says "everything" every time trains the operator to skim —
and the one time it matters, they skim past it.

The fix was to model attenuation. A caller with a fallback path absorbs a failing dependency
and *degrades*; a caller without one passes the failure straight through. Anything past a
graceful degrader sees only latency. Suddenly the reports differed from each other, which is
the entire point of writing one.

```
DOWN      Checkout API [user-facing]  (+1 hop)
          Calls Payments Service with no fallback, so the failure propagates.
DOWN      Edge Gateway [user-facing]  (+2 hop)
          Calls Checkout API with no fallback, so the failure propagates.
```

## Two halves of my own system disagreed and no test caught it

I have a fake production estate with an injectable fault, because a demo that depends on
real flakiness fails on camera. The blast-radius engine predicted the edge gateway would go
down. The estate's own metrics showed it perfectly healthy.

Fault propagation in the estate was single-hop. The engine's traversal was transitive. Each
subsystem was internally consistent and correct against its own tests; they were only wrong
*relative to each other*. The agent was investigating a world it would not then act on.

I only caught it because I put two outputs side by side and looked. There is no unit test
for "these two models of the same thing have drifted", and I still do not know what that
test would look like.

## My tests were wrong three times and the engine was right

This kept happening and it stopped being embarrassing and started being reassuring.

I asserted a "clean rollback" would be `reversible`. It came back `reversible-with-loss` —
the deploy I had picked rolls back onto one whose artifact was already evicted, so returning
requires a rebuild. The engine knew that. I had forgotten.

Later I asserted that a rollback on purely correlational evidence should be rejected. It came
back `approve-with-caution`, and it was right: that rollback was *reversible*.
Irreversibility is what raises the bar. I had encoded "weak evidence is bad" when the actual
rule is "weak evidence is bad *in proportion to what you cannot undo*".

When the model of your domain is stricter than your own recollection of it, the model is
probably earning its keep.

## The approval gap nobody talks about

Standard approval flows have a hole in the middle. The human approves a *description*. The
agent then submits the *actual call*. If those can differ — and nothing usually stops them —
the human approved something else.

So tokens in Blastdoor carry a fingerprint of the approved arguments, are single-use, and
expire after fifteen minutes. The end-to-end suite proves a token issued for one proposal
cannot be redeemed against another:

```
PASS  proposing did NOT execute — the deploy is still live
PASS  execution without a valid token is refused
PASS  a token from another proposal cannot be redeemed
PASS  an approval token is single use
```

That was the point where this stopped feeling like a demo and started feeling like a safety
property.

## The animation that quietly broke the safety story

The console has a confidence gauge that sweeps up to the score. I drove it with
`requestAnimationFrame`.

`requestAnimationFrame` does not fire in a background tab.

An approval console *lives* in a background tab. A proposal arrives, the operator switches
over, and reads a confidence of **0** on a real decision. My animation had become
load-bearing for correctness, which is a thing animations must never be. Values now commit
synchronously and the motion is layered on only when someone is actually watching.

Same category of bug, five minutes later: a race between the topology fetch and the proposal
poll meant the impact map could be correctly populated while every node stayed uncoloured.
The graph would draw the estate and then silently never light up.

Both would have died on camera.

## Hold to confirm

The interaction I am most pleased with is the smallest. An irreversible action should not be
one click away from a tired person, so the approve button does not accept a click — you
press and hold for 1.6 seconds while a ring fills. Release early and it cancels with a shake.

Reversible actions keep a plain click. Friction only means something if it is reserved for
what deserves it; make everything laborious and people learn to rush the ceremony.

The property I like is that unlike a confirmation dialog, you cannot dismiss it without
reading — the wait *is* the reading time. And reduced-motion strips every other animation in
the interface but keeps that delay, because it is a safety mechanism rather than decoration.

## TrueForge did not start on Windows, so I fixed it

Day four, I finally ran the harness and it died instantly:

```
Failed to start server: ERR_UNSUPPORTED_ESM_URL_SCHEME
  Only URLs with a scheme in: file, data, node are supported... Received protocol 'c:'
```

The error is swallowed without a stack. I patched their error handler to print one, found
the trace was entirely inside Node's ESM loader with no application frames, and eventually
traced it to Kysely's `FileMigrationProvider`: it joins the migrations folder and a filename
into an OS path and `import()`s it directly. On Windows that is `C:\…`, which Node's ESM
loader refuses.

Kysely exposes an `import` hook for exactly this. Four lines:

```ts
import: specifier => import(pathToFileURL(specifier).href),
```

It was already filed as [#427](https://github.com/truefoundry/trueforge/issues/427), open
and unfixed. Fixing your sponsor's harness during their own hackathon is a strange and
enjoyable way to spend an afternoon.

## What the harness actually bought me

I wrote none of the agent loop. No tool dispatch, no context management, no session
persistence, no subagent orchestration, no sandbox. I wrote a blast-radius engine, an MCP
server, a fake estate, and a console — and TrueForge ran the agent.

The part I would call out to anyone starting this: **make every harness feature change an
outcome, or it is decoration.** My first pass at subagents was a paragraph in a skill file
telling the agent to delegate. That earns nothing and demonstrates nothing. The version that
works scores independent corroboration higher in the confidence calculation and reports a
lone investigator carrying the whole case as a gap. Now delegation is worth doing, and you
can see in the output whether it happened.

Same with the sandbox. "The agent can run code" is a capability. "Causal evidence is the
only thing that clears the bar for an irreversible action, and the only way to get causal
evidence is to replay the request in the sandbox" is a *reason*.

---

**Code:** https://github.com/mrayhankhan/blastdoor
**Live console:** https://blastdoor-tau.vercel.app

Built solo for the WeMakeDevs Agent Harness Hackathon, August 2026. AI assistance used
throughout, as the rules permit — the architecture and the safety model are mine, and the
bugs above are all real ones I hit.
