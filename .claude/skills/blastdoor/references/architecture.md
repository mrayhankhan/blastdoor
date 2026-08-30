# Architecture

```
                    ┌──────────────────────────────────────┐
                    │            TrueForge  :8790          │
                    │  loop · sandbox · subagents · skills │
                    └───────────────┬──────────────────────┘
                                    │ MCP (streamable HTTP)
                    ┌───────────────▼──────────────────────┐
                    │          ops-mcp  :4300              │
                    │                                      │
                    │  read-only tools ──────────────┐     │
                    │  propose_* ──► blast-radius    │     │
                    │                    engine      │     │
                    │                      │         │     │
                    │                 ┌────▼─────┐   │     │
                    │                 │  broker  │   │     │
                    │                 │ proposals│   │     │
                    │                 └────┬─────┘   │     │
                    └──────────────────────┼─────────┼─────┘
                              HTTP :4200   │         │ HTTP :4000
                    ┌─────────────────────▼──┐   ┌──▼──────────────┐
                    │    console  :4100      │   │  target-stack   │
                    │  human reads & decides │   │  the estate     │
                    └────────────────────────┘   └─────────────────┘
```

## Packages

**`packages/blastdoor-core`** — the engine, and the only exhaustively tested part. Pure, no
I/O. Given a proposed action and the state of the estate it computes reversibility, walks
the dependency graph to find who else is affected, resolves the undo path, scores the
evidence, and checks guardrails. `types.ts` carries the vocabulary, `engine.ts` the logic,
`fixture.ts` the demo world, `render.ts` the terminal approval card.

**`packages/ops-mcp`** — the MCP server and approval broker.
- `tools.ts` exports `buildServer()` and registers all 12 tools.
- `stdio.ts` and `http.ts` are thin transport entrypoints. TrueForge attaches connectors by
  URL (`type: "remote"`), so HTTP is what the harness uses; stdio exists for the e2e suite,
  which drives the real protocol over a spawned process.
- `broker.ts` holds proposals and issues tokens. `broker-api.ts` exposes them to the console
  over HTTP, because the agent arrives over MCP and the operator arrives from a browser.

**`packages/target-stack`** — a deliberately breakable eight-service estate with a
deterministic fault injector, so the demo reproduces exactly every run. Also serves
`/api/replay`, which is what the agent's sandbox code calls.

**`packages/console`** — the approval UI. Plain HTML/CSS/JS plus Three.js, no framework, no
bundler. `graph.js` is the 3D dependency graph; `app.js` orchestrates and holds the
hold-to-confirm; `demo-data.js` is the captured fallback for static hosting.

## The 12 MCP tools

Read-only, safe to call freely, preloaded so investigation starts immediately:
`get_topology`, `get_metrics`, `get_deploys`, `get_traces`, `get_logs`, `get_action_log`,
`get_replay_kit`.

Destructive — these **never execute**, they create a proposal:
`propose_rollback_deploy`, `propose_restart_service`, `propose_scale_service`.

The gate: `check_proposal`, and `execute_approved_action` — the only door to the estate,
requiring a human-issued token.

## Where each TrueForge feature is load-bearing

| Feature | Use | Why removing it breaks the product |
|---|---|---|
| MCP | 12 tools over streamable HTTP | The agent's only route to the estate; there is no back door |
| Sandbox | Replays a request against a deploy and its predecessor | The sole source of `causal` evidence, which is the only thing that clears the bar for an irreversible action |
| Human approval | Every destructive path ends in a proposal; harness approval on `execute_approved_action` sits in front of the broker's token check | Defence in depth |
| Subagents | Competing hypotheses, named, attributed on each piece of evidence | Independent corroboration raises the confidence score; a lone investigator is reported as a gap |
| Skills | Two git-backed skills mounted from the repo | Carry the reasoning discipline the agent follows |
| Deferred tools | Read-only preloaded, destructive deferred | The dangerous surface is not in context until needed |
| Sessions | The broker holds proposals independently of the agent loop | An approval outlives a reconnect |

## The safety property, precisely

A destructive tool call cannot reach the estate unless a human, out of band, issued a token
for **that exact proposal** — identified by a hash of its arguments, not by tool name or
service. This closes the gap in the usual approval pattern, where the human approves a
description and the agent then submits the actual call; if those can differ, the approval
was for something else.

Tokens are single-use and expire after fifteen minutes, because a stale approval is a stale
judgement. `scripts/e2e.ts` asserts all of this over the real protocol, including that a
token issued for one proposal cannot be redeemed against another.

## Ports

| Port | Service |
|---|---|
| 4000 | target-stack |
| 4100 | console |
| 4200 | approval broker (HTTP, for the console) |
| 4210 | e2e's own broker (override with `BROKER_PORT`) |
| 4300 | ops-mcp streamable HTTP (`/mcp`, `/health`) |
| 8790 | TrueForge |
