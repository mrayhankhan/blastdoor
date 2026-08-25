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

Call `get_replay_kit` first. It returns the replay endpoint, its contract, and the deploy
list. Then write your own script and run it in the sandbox — this is the step that converts
a correlation into causal evidence, and it is the only way to get there.

The comparison that matters is **the same request shape against the suspect deploy and
against its predecessor**:

```js
const replay = (service, deployId, requestShape) =>
  fetch(`${STACK}/api/replay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service, deployId, requestShape }),
  }).then((r) => r.json());

const suspect = await replay('checkout-api', 'dep-9f12', 'guest checkout');
const baseline = await replay('checkout-api', 'dep-8e01', 'guest checkout');
// fail then pass is causal. fail then fail means you have the wrong deploy.
```

Replaying only the suspect proves nothing — without a baseline you cannot tell a broken
deploy from a broken request. A fail-then-pass pair is causal evidence and should be
submitted with `strength: "causal"` and `source: "sandbox-replay"`. A fail-then-fail pair is
just as valuable: it eliminates your leading hypothesis, and reporting that honestly is
better than quietly moving on to the next one.

Bisect the same way when several deploys are candidates.

## Delegate competing hypotheses

If there are several plausible causes, give each to a subagent and let them work
independently. Sequential investigation tends to confirm whatever you looked at first;
parallel investigation does not, because the subagents cannot see each other's reasoning.

Name each one for the hypothesis it is testing — `deploy-hypothesis`,
`dependency-hypothesis`, `capacity-hypothesis` — and pass that name as the `investigator`
field on every piece of evidence it produced. This is not bookkeeping: Blastdoor scores
corroboration from independent investigators higher than the same claim restated, and names
a single investigator carrying the whole case as a gap. If you delegate but do not attribute,
you lose the credit for having done it.

Subagents that disagree are the most useful outcome. It means the picture is not yet clear
enough to act on, and that is worth reporting rather than resolving by picking a favourite.

## Know when not to act

Some incidents do not have a safe action available yet. A change freeze is on, the only fix
takes down the last replica, the evidence is purely correlational. In those cases the correct
output is a clear account of what you know and what you would need to know, handed to a human.

Reporting "I cannot safely act yet, and here is exactly what is missing" is a successful
outcome. Proposing a destructive action on thin evidence to look decisive is not.
