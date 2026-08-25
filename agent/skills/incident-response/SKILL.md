---
name: incident-response
description: How to work an incident in this estate — tracing a symptom back to its origin, distinguishing cause from coincidence, and testing a hypothesis in the sandbox before proposing anything. Use whenever an alert fires, a metric looks wrong, or someone asks what is happening in production.
---

# Working an incident

The mistake this skill exists to prevent: finding the most recent change, noticing it happened
before the symptom, and calling that a root cause. It is right often enough to feel reliable
and wrong often enough to cause outages.

## Find the origin, not the loudest signal

Faults propagate to callers, attenuating as they go. A service with a fallback path absorbs
most of a failure; one without passes nearly all of it on. So the service with the highest
error rate is usually the origin, and the services that paged are usually downstream of it.

Pull metrics for the whole estate, not the alerting service. Sort by error rate. Walk the
topology from the worst-affected service downward through `dependsOn` until the error rate
stops rising. That is your origin.

## Separate cause from coincidence

Once you have a candidate service, the question is what changed there. Deploy history gives
you leads. Traces give you causes.

A trace that fails and terminates inside the changed code path is causal evidence. A deploy
that landed six minutes before the spike is correlational — and the estate deploys often
enough that there is nearly always a recent deploy to blame.

The test worth applying: if this deploy had not happened, would the symptom still be here?
Usually you cannot know that from observation alone, which is what the sandbox is for.

## Use the sandbox to actually check

When a hypothesis is testable, test it rather than asserting it. Useful shapes:

- **Replay** the failing request shape against the previous version and see whether it
  succeeds. A pass here is strong causal evidence.
- **Bisect** across the last several deploys when there is more than one candidate.
- **Check the correlation holds outside the window** — pull a longer metric range and see
  whether the same pattern appears around earlier deploys of the same kind. If it does, the
  deploy is probably not the cause.

Write real code and run it. A sandbox result is evidence; a plausible argument is not.

## Delegate competing hypotheses

If there are several plausible causes, give each to a subagent and let them work
independently. Independent investigation is more useful than sequential investigation because
subagents that reach the same conclusion by different routes give you corroboration, and
subagents that disagree tell you the picture is not yet clear enough to act on.

## Know when not to act

Some incidents do not have a safe action available yet. A change freeze is on, the only fix
takes down the last replica, the evidence is purely correlational. In those cases the correct
output is a clear account of what you know and what you would need to know, handed to a human.

Reporting "I cannot safely act yet, and here is exactly what is missing" is a successful
outcome. Proposing a destructive action on thin evidence to look decisive is not.
