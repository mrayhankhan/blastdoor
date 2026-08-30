# Build notes

Running log of decisions, surprises, and dead ends. This becomes the blog post.

## Day 1 — 25 Aug

**The premise.** Every agent framework ships human-in-the-loop approval and almost all of it
is `[y/N]`. The pause exists but it carries no information, so the operator approves on vibes.
Decided the interesting problem is not *pausing* — it is *what the pause tells you*.

**Reversibility is not a boolean.** First cut of the type was `reversible: boolean`. That fell
over on the first real case: rolling back a deploy that carried a schema migration. The code
goes back, the schema does not. It is not reversible, but it is also not the same kind of
irreversible as dropping a table. Ended up with a four-state ladder — reversible, reversible
within a window, reversible with loss, irreversible — and the whole design got better once the
type stopped lying.

**Naive graph traversal is useless.** First version of the blast-radius walk concluded "the
entire estate is affected" on literally every input, because in a connected graph it always is.
Technically correct, completely unactionable, and it would train an operator to skim past the
one report that mattered. Fixed by modelling attenuation: a caller with a fallback path absorbs
a failure and degrades rather than dying, and anything past that sees only latency. Suddenly
the reports differ from each other, which is the entire point.

**Two halves of the system disagreed.** Caught this by eye comparing output: the blast-radius
engine predicted the edge gateway would go down, but the target stack's metrics showed it
perfectly healthy. Fault propagation in the stack was single-hop while the engine's traversal
was transitive. The agent was investigating a world it would not then act on. Made propagation
transitive with the same attenuation rule. Worth noting that no test caught this — the two
subsystems were each internally consistent and only wrong relative to each other.

**Test fixture taught me something.** Wrote a test asserting a "clean rollback" was
`reversible` and it failed with `reversible-with-loss`. The engine was right and I was wrong:
the deploy I picked rolls back onto one whose artifact was already evicted, so returning
requires a rebuild. Changed the fixture, kept the engine. Good sign when the model of the
domain is stricter than your own recollection of it.

**Binding the token to the arguments.** The standard approval flow has a gap nobody talks
about: the human approves a description, and the agent then submits the actual call. If those
can differ, the approval was for something else. Made the token carry a fingerprint of the
approved arguments and checked it on redemption. The e2e suite now proves a token approved for
one proposal cannot be redeemed against another — which felt like the moment this stopped
being a demo and started being a safety property.

**Node 24 runs TypeScript directly.** No build step, no bundler, no `dist/`. A judge clones and
runs. Genuinely one of the highest-leverage decisions of the day for a repo someone has to be
able to pick up in five minutes.

### Still open

- Sandbox integration is described in the agent instructions but not yet exercised end to end
  against a real TrueForge sandbox provider.
- Subagent delegation is specified in the skills, not yet demonstrated on camera.
- Session persistence across a harness reconnect needs to be shown in the demo, not just be
  true.
- Nothing deployed yet; judges reward a live URL over localhost.
- **Evidence provenance is not verified.** Qodo caught this reading the README: the engine
  scores the `strength` label the agent supplies and never checks that a sandbox replay
  actually ran, so a mislabelled `causal` clears the bar. It does not breach the safety
  property — execution still needs a human-issued token bound to the arguments — but it does
  mean the confidence number is advisory rather than enforced, and the README now says so.
  The fix is an append-only replay log on the target stack that `propose_*` checks claimed
  replay evidence against, downgrading anything unverifiable.
