/**
 * Renders the three approval cards the demo video walks through, without needing the
 * harness, the MCP server, or a model. Useful for rehearsing the demo, for screenshots,
 * and for anyone reviewing the repo who wants to see the output in one command.
 *
 *   node scripts/demo.ts
 */
import { computeBlastRadius, freshState } from '../packages/blastdoor-core/src/index.ts';
import { renderApprovalCard } from '../packages/blastdoor-core/src/render.ts';
import type { ActionProposal } from '../packages/blastdoor-core/src/types.ts';

const scenarios: Array<{ title: string; proposal: ActionProposal; mutate?: (s: ReturnType<typeof freshState>) => void }> = [
  {
    title: 'Scenario 1 — the obvious rollback that is not reversible',
    proposal: {
      tool: 'rollback_deploy',
      args: { service: 'payments-svc', deployId: 'dep-4c21' },
      rationale:
        'Payment failure rate rose sharply about six minutes after dep-4c21 landed, and that deploy changed the ' +
        'provider timeout. Rolling it back should restore the previous behaviour.',
      evidence: [
        {
          id: 'e1',
          source: 'deploys',
          claim: 'dep-4c21 landed at 13:42; error rate crossed threshold at 13:48.',
          strength: 'correlational',
          observedAt: '2026-08-25T13:48:00Z',
        },
        {
          id: 'e2',
          source: 'metrics',
          claim: 'payments-svc error rate went from 0.4% to 11.2%.',
          strength: 'correlational',
          observedAt: '2026-08-25T13:52:00Z',
        },
      ],
    },
  },
  {
    title: 'Scenario 2 — same intent, better evidence, a genuinely clean target',
    proposal: {
      tool: 'rollback_deploy',
      args: { service: 'checkout-api', deployId: 'dep-9f12' },
      rationale:
        'Checkout traces fail inside the funnel copy change introduced by dep-9f12. The previous artifact is ' +
        'retained and no migration was involved.',
      evidence: [
        {
          id: 'e1',
          source: 'traces',
          claim: 'Every failing checkout span terminates inside the dep-9f12 code path.',
          strength: 'causal',
          observedAt: '2026-08-25T14:02:00Z',
        },
        {
          id: 'e2',
          source: 'logs',
          claim: 'Error log volume tracks the dep-9f12 rollout window exactly.',
          strength: 'correlational',
          observedAt: '2026-08-25T14:03:00Z',
        },
        {
          id: 'e3',
          source: 'sandbox-bisect',
          claim: 'Replaying the failing request against dep-8e01 in the sandbox succeeds.',
          strength: 'causal',
          observedAt: '2026-08-25T14:09:00Z',
        },
      ],
    },
  },
  {
    title: 'Scenario 3 — a restart that is quietly a full outage',
    proposal: {
      tool: 'restart_service',
      args: { service: 'sessions-cache' },
      rationale: 'Sessions cache memory is climbing; a restart will reclaim it.',
      evidence: [
        {
          id: 'e1',
          source: 'metrics',
          claim: 'sessions-cache RSS has grown 40% in four hours with no eviction.',
          strength: 'causal',
          observedAt: '2026-08-25T14:11:00Z',
        },
      ],
    },
  },
];

for (const scenario of scenarios) {
  const state = freshState();
  scenario.mutate?.(state);

  console.log('\n\n' + '='.repeat(72));
  console.log(scenario.title);
  console.log('='.repeat(72) + '\n');
  console.log(renderApprovalCard(computeBlastRadius(scenario.proposal, state)));
}
