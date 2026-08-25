/**
 * MCP server exposing the ops estate to the agent.
 *
 * Tools come in two classes and the distinction is enforced, not documented:
 *
 *   Read-only tools reach the target stack directly. The agent may call them freely and
 *   as often as it likes; investigating is not dangerous.
 *
 *   Destructive tools do not execute. Calling one produces a blast-radius report and a
 *   pending proposal, and returns that to the agent. The only path to actually running
 *   the action is `execute_approved_action`, which requires a token that a human issued
 *   from the console for that exact proposal.
 *
 * The agent therefore cannot break anything by being wrong, confused, or prompt-injected.
 * It can only ever produce a well-argued request.
 *
 *   node packages/ops-mcp/src/server.ts        # stdio transport
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { computeBlastRadius } from '../../blastdoor-core/src/engine.ts';
import { renderApprovalCard } from '../../blastdoor-core/src/render.ts';
import type { ActionProposal, Evidence } from '../../blastdoor-core/src/types.ts';
import { broker } from './broker.ts';
import { startBrokerApi } from './broker-api.ts';

const STACK = process.env.TARGET_STACK_URL ?? 'http://localhost:4000';

async function stack(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${STACK}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`target-stack ${path} -> ${res.status}`);
  return res.json();
}

/** Shared shape for evidence the agent attaches to a proposal. */
const evidenceSchema = z
  .array(
    z.object({
      source: z.string().describe('Which read-only tool produced this observation.'),
      claim: z.string().describe('What was observed, in one sentence.'),
      strength: z
        .enum(['causal', 'correlational', 'circumstantial'])
        .describe(
          'causal = directly links the change to the symptom. correlational = they happened near each other in time. Be honest here; overstating is how bad rollbacks get approved.',
        ),
    }),
  )
  .describe('Everything you actually observed that supports this action.');

function toEvidence(raw: Array<{ source: string; claim: string; strength: Evidence['strength'] }>): Evidence[] {
  return raw.map((e, i) => ({
    id: `e${i + 1}`,
    source: e.source,
    claim: e.claim,
    strength: e.strength,
    observedAt: new Date().toISOString(),
  }));
}

const server = new McpServer({ name: 'blastdoor-ops', version: '0.1.0' });

// ---------------------------------------------------------------------------
// Read-only tools. Safe to call, safe to call repeatedly.
// ---------------------------------------------------------------------------

server.tool(
  'get_topology',
  'Service dependency graph, replica counts, and whether each service degrades gracefully. Start here.',
  {},
  async () => text(await stack('/api/topology')),
);

server.tool(
  'get_metrics',
  'Current error rate, p99 latency, and RPS per service. Omit `service` for the whole estate.',
  { service: z.string().optional() },
  async ({ service }) => text(await stack(`/api/metrics${service ? `?service=${service}` : ''}`)),
);

server.tool(
  'get_deploys',
  'Deploy history, newest first. Includes whether each deploy carried a schema migration and whether its artifact is still retained.',
  { service: z.string().optional() },
  async ({ service }) => text(await stack(`/api/deploys${service ? `?service=${service}` : ''}`)),
);

server.tool(
  'get_traces',
  'Recent request traces, including where failing traces terminate. The single most useful tool for finding a cause rather than a correlation.',
  { service: z.string().optional(), limit: z.number().int().min(1).max(50).optional() },
  async ({ service, limit }) => {
    const params = new URLSearchParams();
    if (service) params.set('service', service);
    if (limit) params.set('limit', String(limit));
    return text(await stack(`/api/traces?${params}`));
  },
);

server.tool(
  'get_logs',
  'Recent log lines for one service.',
  { service: z.string(), limit: z.number().int().min(1).max(100).optional() },
  async ({ service, limit }) => {
    const params = new URLSearchParams({ service });
    if (limit) params.set('limit', String(limit));
    return text(await stack(`/api/logs?${params}`));
  },
);

server.tool(
  'get_action_log',
  'Every action attempted against the estate in this session, including ones that were blocked.',
  {},
  async () => text(await stack('/api/actions')),
);

// ---------------------------------------------------------------------------
// Destructive tools. These never execute. They produce a proposal for a human.
// ---------------------------------------------------------------------------

async function propose(action: ActionProposal) {
  const [topology, deploys] = await Promise.all([stack('/api/topology'), stack('/api/deploys')]);

  const report = computeBlastRadius(action, {
    services: topology.services,
    deploys: deploys.deploys,
    changeFreeze: topology.changeFreeze,
  });

  const proposal = broker.create(action, report);

  return text({
    proposalId: proposal.id,
    status: 'AWAITING HUMAN APPROVAL — this action has NOT been executed.',
    recommendation: report.recommendation,
    headline: report.headline,
    approvalCard: renderApprovalCard(report),
    nextStep:
      report.recommendation === 'reject'
        ? 'Blastdoor recommends against this. Report the reasoning to the operator and consider gathering the missing evidence named under CONFIDENCE before re-proposing.'
        : 'Tell the operator this is waiting in the Blastdoor console. If they approve it, they will give you a token to pass to execute_approved_action.',
  });
}

server.tool(
  'propose_rollback_deploy',
  'Propose rolling a service back to its previous deploy. This does NOT execute — it produces a blast-radius report for a human to approve.',
  {
    service: z.string(),
    deployId: z.string().describe('The deploy to roll back FROM, e.g. dep-4c21.'),
    rationale: z.string().describe('Why this deploy is the cause, in your own words.'),
    evidence: evidenceSchema,
  },
  async ({ service, deployId, rationale, evidence }) =>
    propose({ tool: 'rollback_deploy', args: { service, deployId }, rationale, evidence: toEvidence(evidence) }),
);

server.tool(
  'propose_restart_service',
  'Propose restarting a service. This does NOT execute — it produces a blast-radius report for a human to approve.',
  { service: z.string(), rationale: z.string(), evidence: evidenceSchema },
  async ({ service, rationale, evidence }) =>
    propose({ tool: 'restart_service', args: { service }, rationale, evidence: toEvidence(evidence) }),
);

server.tool(
  'propose_scale_service',
  'Propose changing a service replica count. This does NOT execute — it produces a blast-radius report for a human to approve.',
  { service: z.string(), replicas: z.number().int().min(0), rationale: z.string(), evidence: evidenceSchema },
  async ({ service, replicas, rationale, evidence }) =>
    propose({ tool: 'scale_service', args: { service, replicas }, rationale, evidence: toEvidence(evidence) }),
);

// ---------------------------------------------------------------------------
// The only door to the target system.
// ---------------------------------------------------------------------------

server.tool(
  'check_proposal',
  'Check whether a human has approved a proposal yet, and collect the token if they have.',
  { proposalId: z.string() },
  async ({ proposalId }) => {
    const proposal = broker.get(proposalId);
    if (!proposal) return text({ error: `No proposal ${proposalId}.` });
    return text({
      proposalId: proposal.id,
      status: proposal.status,
      decidedBy: proposal.decidedBy,
      decisionNote: proposal.decisionNote,
      // The token is deliberately not returned here. The human hands it over, which keeps
      // the approval an act a person performs rather than a state the agent polls for.
      tokenAvailable: proposal.token !== null,
    });
  },
);

server.tool(
  'execute_approved_action',
  'Execute a proposal that a human approved. Requires the approval token the operator gives you. Fails if the arguments differ in any way from what was approved.',
  {
    proposalId: z.string(),
    approvalToken: z.string().describe('Given to you by the operator after they approve in the console.'),
  },
  async ({ proposalId, approvalToken }) => {
    const pending = broker.get(proposalId);
    if (!pending) return text({ ok: false, error: `No proposal ${proposalId}.` });

    const redeemed = broker.redeem(proposalId, approvalToken, pending.action);
    if (!redeemed.ok) return text({ ok: false, error: redeemed.error });

    const result = await stack('/api/execute', {
      method: 'POST',
      body: JSON.stringify({ tool: pending.action.tool, args: pending.action.args }),
    });

    return text({
      ok: result.ok,
      executed: pending.action.tool,
      args: pending.action.args,
      approvedBy: pending.decidedBy,
      result: result.message,
      nextStep: 'Verify with get_metrics that the symptom actually cleared before declaring the incident resolved.',
    });
  },
);

function text(payload: unknown) {
  return { content: [{ type: 'text' as const, text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] };
}

startBrokerApi();

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[ops-mcp] connected over stdio; target stack at ' + STACK);
