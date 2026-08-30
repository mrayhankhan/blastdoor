# Decisions and bugs

Why the non-obvious things are the way they are, and the real bugs hit along the way. This
is also the raw material behind `BLOG.md` — if the blog post needs expanding, expand from
here rather than inventing.

## Design decisions worth not undoing

**Reversibility is a four-state ladder, not a boolean.** `reversible`,
`reversible-within-window`, `reversible-with-loss`, `irreversible`. A boolean fell over
within an hour: rolling back a deploy that carried a schema migration moves the code back
but not the schema, which is not reversible — and also not the same species of irreversible
as dropping a table. Every downstream decision (the verdict, the confidence bar, whether the
UI demands a hold) depends on this distinction.

**Impact attenuates through the dependency graph.** A naive traversal reports everything
reachable, which in a connected graph is always everything: true, useless, and it trains
operators to skim. A caller with a fallback absorbs a failure and degrades; one without
passes it through; anything past a graceful degrader sees only latency.

**Confidence separates causal from correlational evidence and names the gaps.** The failure
mode being guarded against is the agent's most seductive one — finding a deploy shortly
before a spike and calling it a cause. Correlational evidence is kept, scored low, and
explicitly labelled as a gap rather than folded into a confident number.

**The bar scales with irreversibility, not with danger in general.** A reversible rollback
on correlational evidence is legitimately `approve-with-caution`. The same evidence against
a migration-crossing target is `reject`. This is asserted directly in the tests.

**Approval tokens are bound to an argument fingerprint**, single-use, 15-minute expiry. See
`architecture.md` for why.

**Zero build step.** TypeScript runs directly under Node 22+. Deliberate, so a judge can
clone and run. Do not add a bundler.

**Hold-to-confirm only for irreversible actions.** Reversible ones keep a plain click.
Friction only means something if it is reserved for what deserves it. Reduced-motion strips
every other animation but keeps the hold delay, because that delay is a safety mechanism
rather than decoration.

## Bugs found, and what they teach

**Two halves of the system disagreed and no test caught it.** The blast-radius engine
predicted the edge gateway would go down; the estate's own metrics showed it healthy. Fault
propagation in the estate was single-hop while the engine's traversal was transitive. Each
subsystem was internally consistent and correct against its own tests — they were only wrong
relative to each other. Caught by putting two outputs side by side and looking. There is no
obvious unit test for "these two models of the same thing have drifted".

**Three test expectations were wrong and the engine was right.**
- Asserted a "clean rollback" was `reversible`; it was `reversible-with-loss`, because the
  target deploy's artifact had been evicted and returning requires a rebuild.
- Asserted a correlational-evidence rollback should be rejected; it was correctly
  `approve-with-caution` because that rollback was reversible.
- Asserted an arbitrary confidence threshold of 75; the real property is the delta against
  the same case without the sandbox replay.

When the model of the domain is stricter than your own recollection of it, the model is
earning its keep.

**`requestAnimationFrame` does not fire in a background tab.** The confidence gauge animated
up to its score with rAF — and an approval console lives in a background tab. A proposal
arrives, the operator switches over, and reads confidence **0** on a real decision. An
animation had become load-bearing for correctness. Values now commit synchronously and
motion is layered on only when someone is watching.

**A race between the topology fetch and the proposal poll** meant the impact map could be
correctly populated while every node stayed uncoloured — the graph would draw the estate and
then silently never light up.

**The demo driver would have sabotaged the video.** It advanced on timers totalling ~25s
while `DEMO.md` scheduled a 35s narration for the rejection card, so the sandbox result and
the 91/100 proposal would have appeared while the voiceover was still on scene 2 — exactly
the failure the driver existed to prevent. Scenes now advance on a keypress.

**The README's own workflow was broken.** Cloning fresh and following it as written
(`npm run mcp`, then `npm run e2e`) failed: the suite spawned its own broker on the same
port and silently reported zero passes. Fresh-clone testing is worth doing before submitting
anything.

**`E2E_BROKER_PORT` vs `BROKER_PORT`.** The broker's own port-clash message told the user to
set a variable the suite ignored. One name now.

**TrueForge did not start on Windows.** Traced to Kysely's `FileMigrationProvider`
`import()`ing a raw `C:\…` path. The error is swallowed without a stack; patching the
handler to print one showed a trace entirely inside Node's ESM loader with no application
frames. Fix is a four-line `import` hook using `pathToFileURL`. Upstream issue #427.

## Rules constraints worth remembering

- Submission needs: public repo, README with setup steps, ~3 minute demo video, write-up of
  the agent and how TrueForge is used. Blog post optional and separately prized.
- Open source, and a judge must be able to run it.
- AI assistance is allowed but **must be disclosed**, and the builder must be able to
  explain the architecture. Disclosure is in both `README.md` and `SUBMISSION.md`.
- Three judged tracks — Best Use of TrueForge, Best Code Quality, Best UI — and a team may
  win **only one**. Qodo is required for Best Code Quality.
- Only work done during the hackathon is judged, which is part of why the PR trail matters.
