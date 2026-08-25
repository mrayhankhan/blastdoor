import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeBlastRadius, scoreConfidence, traverseImpact } from '../src/engine.ts';
import { freshState, SERVICES } from '../src/fixture.ts';
import type { ActionProposal, Evidence } from '../src/types.ts';

const causal = (id: string): Evidence => ({
  id,
  source: 'traces',
  claim: 'Every failing checkout trace terminates in a payments-svc provider timeout.',
  strength: 'causal',
  observedAt: '2026-08-25T14:02:00Z',
});

const correlational = (id: string, source = 'deploys'): Evidence => ({
  id,
  source,
  claim: 'Error rate rose 6 minutes after dep-4c21 landed.',
  strength: 'correlational',
  observedAt: '2026-08-25T13:48:00Z',
});

function proposal(over: Partial<ActionProposal> = {}): ActionProposal {
  return {
    tool: 'rollback_deploy',
    args: { service: 'payments-svc', deployId: 'dep-4c21' },
    rationale: 'Payment failures began shortly after this deploy raised the provider timeout.',
    evidence: [correlational('e1')],
    ...over,
  };
}

test('impact attenuates through services that degrade gracefully', () => {
  const impacted = traverseImpact(SERVICES, 'search-svc', 'unavailable');
  const catalog = impacted.find((i) => i.serviceId === 'catalog-api');

  // Catalog has a fallback path, so a dead search backend degrades it rather than
  // taking it down. That distinction is the point of the traversal.
  assert.equal(catalog?.effect, 'degraded');
});

test('impact propagates hard through services with no fallback', () => {
  const impacted = traverseImpact(SERVICES, 'payments-svc', 'unavailable');
  const checkout = impacted.find((i) => i.serviceId === 'checkout-api');

  assert.equal(checkout?.effect, 'unavailable');
  assert.equal(checkout?.userFacing, true);
});

test('a rollback across a schema migration is reported as irreversible', () => {
  const report = computeBlastRadius(proposal(), freshState());

  // dep-4c21 carries a migration, so rolling the code back does not roll the schema
  // back. This is the case the whole project exists to surface.
  assert.equal(report.reversibility, 'irreversible');
  assert.equal(report.undo.possible, false);
  assert.match(report.undo.residualLoss ?? '', /migration is already applied/i);
});

test('an irreversible action on correlational evidence alone is rejected', () => {
  const report = computeBlastRadius(proposal(), freshState());

  assert.equal(report.recommendation, 'reject');
  assert.ok(
    report.confidence.gaps.some((g) => /timing alone/i.test(g)),
    'expected the report to name timing-only reasoning as a gap',
  );
});

test('a clean rollback with corroborated causal evidence is approvable', () => {
  // dep-9f12 -> dep-8e01: artifact still retained, no migration, so this is the one
  // shape of rollback that really is a clean there-and-back-again.
  const report = computeBlastRadius(
    proposal({
      args: { service: 'checkout-api', deployId: 'dep-9f12' },
      evidence: [
        causal('e1'),
        correlational('e2'),
        { ...correlational('e3', 'logs'), claim: 'Error log volume tracks the deploy window.' },
      ],
    }),
    freshState(),
  );

  assert.equal(report.reversibility, 'reversible');
  assert.equal(report.undo.possible, true);
  assert.notEqual(report.recommendation, 'reject');
});

test('a change freeze blocks the action regardless of evidence quality', () => {
  const state = freshState();
  state.changeFreeze = { active: true, reason: 'Bank holiday sale, 25-26 Aug' };

  const report = computeBlastRadius(
    proposal({
      args: { service: 'payments-svc', deployId: 'dep-3b90' },
      evidence: [causal('e1'), causal('e2')],
    }),
    state,
  );

  assert.equal(report.recommendation, 'reject');
  assert.ok(report.guardrails.some((g) => g.id === 'change-freeze' && g.severity === 'block'));
});

test('restarting a single-replica service is blocked as a disguised outage', () => {
  const report = computeBlastRadius(
    proposal({
      tool: 'restart_service',
      args: { service: 'sessions-cache' },
      evidence: [causal('e1')],
    }),
    freshState(),
  );

  assert.ok(report.guardrails.some((g) => g.id === 'last-replica' && g.severity === 'block'));
  assert.equal(report.recommendation, 'reject');
});

test('confidence names the single-source gap when evidence is not corroborated', () => {
  const conf = scoreConfidence([correlational('e1'), correlational('e2')]);

  assert.ok(conf.score < 60);
  assert.ok(conf.gaps.some((g) => /would not be visible/i.test(g)));
});

test('an unmodelled tool is treated as irreversible rather than assumed safe', () => {
  const report = computeBlastRadius(
    proposal({ tool: 'drop_table', args: { service: 'ledger-db' }, evidence: [causal('e1')] }),
    freshState(),
  );

  assert.equal(report.reversibility, 'irreversible');
  assert.equal(report.undo.possible, false);
});
