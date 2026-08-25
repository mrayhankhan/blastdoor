/**
 * Bundled sample data for the public deployment.
 *
 * The full system is three processes — the estate, the broker, and this console — and
 * none of them survive on static hosting. Rather than deploy a console that shows an
 * error, the deployed build falls back to a real captured proposal so the interface can
 * actually be explored. It is labelled as a demo everywhere it appears, because a
 * safety tool that quietly shows fake data would be exactly the wrong thing to build.
 *
 * These values are the genuine output of `computeBlastRadius` for the payments-svc
 * rollback scenario, captured from a local run.
 */

export const DEMO_TOPOLOGY = [
  { id: 'edge-gateway', displayName: 'Edge Gateway', dependsOn: ['checkout-api', 'catalog-api'], rps: 1400, replicas: 6, degradesGracefully: false, userFacing: true },
  { id: 'checkout-api', displayName: 'Checkout API', dependsOn: ['payments-svc', 'inventory-svc', 'sessions-cache'], rps: 320, replicas: 4, degradesGracefully: false, userFacing: true },
  { id: 'catalog-api', displayName: 'Catalog API', dependsOn: ['search-svc', 'sessions-cache'], rps: 980, replicas: 5, degradesGracefully: true, userFacing: true },
  { id: 'payments-svc', displayName: 'Payments Service', dependsOn: ['ledger-db'], rps: 310, replicas: 3, degradesGracefully: false, userFacing: false },
  { id: 'inventory-svc', displayName: 'Inventory Service', dependsOn: ['ledger-db'], rps: 260, replicas: 2, degradesGracefully: true, userFacing: false },
  { id: 'search-svc', displayName: 'Search Service', dependsOn: [], rps: 640, replicas: 3, degradesGracefully: true, userFacing: false },
  { id: 'sessions-cache', displayName: 'Sessions Cache', dependsOn: [], rps: 2100, replicas: 1, degradesGracefully: false, userFacing: false },
  { id: 'ledger-db', displayName: 'Ledger Database', dependsOn: [], rps: 570, replicas: 1, degradesGracefully: false, userFacing: false },
];

export const DEMO_PROPOSALS = [
  {
    id: 'prop_demo01',
    createdAt: '2026-08-25T13:52:00Z',
    status: 'pending',
    tool: 'rollback_deploy',
    args: { service: 'payments-svc', deployId: 'dep-4c21' },
    rationale:
      'Payment failures began about six minutes after dep-4c21 landed, and that deploy raised the ' +
      'provider timeout from 2s to 4s.',
    recommendation: 'reject',
    headline: 'Do not run this yet — irreversible, touches 3 service(s), 2 user-facing, confidence 28/100.',
    reversibility: 'irreversible',
    confidence: {
      score: 28,
      basis: [
        '2 correlational signal(s): dep-4c21 landed at 13:42; error rate crossed threshold at 13:48.; payments-svc error rate went from 0.4% to 11.2%.',
      ],
      gaps: [
        'No direct causal evidence — nothing observed actually links the change to the symptom.',
        'The case rests on timing alone. Something else changing in the same window would produce the same picture.',
        'All evidence comes from 2 tool(s). A fault in that source would not be visible from here.',
      ],
    },
    impacted: [
      { serviceId: 'checkout-api', displayName: 'Checkout API', hops: 1, effect: 'unavailable', userFacing: true, reasoning: 'Calls Payments Service with no fallback, so the failure propagates.' },
      { serviceId: 'edge-gateway', displayName: 'Edge Gateway', hops: 2, effect: 'unavailable', userFacing: true, reasoning: 'Calls Checkout API with no fallback, so the failure propagates.' },
      { serviceId: 'payments-svc', displayName: 'Payments Service', hops: 0, effect: 'unavailable', userFacing: false, reasoning: 'Direct target of the action.' },
    ],
    inFlight: {
      requestsAffected: 91350,
      windowSeconds: 45,
      basis: '2030 rps across affected services for a 45s convergence window.',
    },
    undo: {
      possible: false,
      procedure: [],
      windowSeconds: null,
      residualLoss:
        'The migration is already applied. Rolling the code back leaves old code running against a new schema, ' +
        'and rolling forward again will not replay writes rejected in the meantime.',
    },
    guardrails: [
      { id: 'user-facing-outage', severity: 'warn', message: 'This makes 2 user-facing service(s) unavailable: Checkout API, Edge Gateway.' },
      { id: 'weak-evidence', severity: 'warn', message: 'Confidence is 28/100. Acting now is a guess, and the guess is destructive.' },
    ],
    evidence: [],
    decidedBy: null,
    decisionNote: null,
  },
];
