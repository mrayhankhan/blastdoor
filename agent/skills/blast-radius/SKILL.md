---
name: blast-radius
description: How to write a proposal a human can actually decide on — classifying evidence honestly, writing a rationale for a tired reader, and responding correctly when Blastdoor rejects the proposal. Use whenever you are about to call a propose_* tool or have just had one rejected.
---

# Writing a proposal someone can decide on

The person reading your proposal is under time pressure and the cost of them skimming is an
outage. Everything below is about making their decision fast and correct rather than making
your proposal look strong.

## Classify evidence honestly

Each piece of evidence carries a strength, and Blastdoor scores the proposal on it. The
temptation is to upgrade correlational evidence to causal because you are confident. Resist
it — the score exists precisely to catch confidence unsupported by observation, and inflating
it defeats the only mechanism protecting the estate from you being wrong.

**Causal** means you observed something that directly links the change to the symptom:

- A failing trace terminating inside the changed code path.
- A sandbox replay that fails on the current version and succeeds on the previous one.
- A log line naming the specific new behaviour at the moment of failure.

**Correlational** means the two things happened near each other:

- A deploy landed shortly before the error rate rose.
- Two metrics moved together.

**Circumstantial** means it fits but does not constrain — the changed code is in the right
area, the timing is plausible.

Evidence from several independent tools is worth more than several observations from one,
because a fault in a single source is invisible from inside that source. If everything you
have came from metrics, say so.

## Write the rationale for the reader

Three things, in this order: what you think broke, what makes you think so, and what you are
unsure about. The third one is the one that gets left out and the one that most helps the
person deciding.

Do not restate the blast-radius report — they can see it. Do not argue for approval. Give them
the picture and let them decide.

## When Blastdoor rejects

A rejection is information, not an obstacle. Read which kind it is.

**Evidence rejection** — confidence too low, gaps named explicitly. The gaps tell you exactly
what to go and observe. Get it, then propose again. Re-proposing the same evidence with a more
confident rationale is the one response that is always wrong.

**Reversibility rejection** — the action is irreversible and the evidence does not clear the
higher bar that irreversibility demands. Consider whether a reversible action would tell you
the same thing. Often a scale-up or a restart is diagnostic where a rollback is a commitment.

**Guardrail block** — a change freeze, a last-replica restart. Do not route around it. Report
it to the operator with what you would do if it were lifted. Overriding policy is a human's
call.

## Prefer the smallest action that tests your belief

If you believe a deploy caused the problem, the rollback is the commitment, not the
experiment. A sandbox replay tests the same belief and costs nothing. Reach for the
irreversible action only when the reversible ones have run out.
