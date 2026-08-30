/**
 * End-to-end check of the safety property, driving the MCP server exactly as the harness
 * would: over stdio, using the real protocol, against the real target stack.
 *
 * What it proves, in order:
 *   1. Read-only tools work and the agent can investigate.
 *   2. A destructive tool call does NOT reach the target system.
 *   3. Executing without a token fails.
 *   4. Executing with a token issued for DIFFERENT arguments fails.
 *   5. Executing with the right token succeeds and the symptom actually clears.
 *
 *   node scripts/e2e.ts     (requires target-stack running on :4000)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The suite spawns its own MCP server, which brings up its own broker. Using the default
// port would collide with a `npm run mcp` already running in another terminal — which is
// exactly what the README tells you to do — so the suite runs on its own ports and can
// coexist with a live stack. It deliberately shares the target stack, because asserting
// that the symptom actually clears means acting on the real one.
// Same knob name the broker's own port-clash message tells you to set, so following that
// advice actually works. Only the default differs from the broker's, to stay clear of a
// `npm run mcp` on 4200.
const BROKER_PORT = process.env.BROKER_PORT ?? '4210';
const BROKER = `http://localhost:${BROKER_PORT}`;
const STACK = process.env.TARGET_STACK_URL ?? 'http://localhost:4000';

const ok = (label: string) => console.log(`  PASS  ${label}`);
const fail = (label: string, detail?: unknown) => {
  console.log(`  FAIL  ${label}`);
  if (detail !== undefined) console.log('        ' + JSON.stringify(detail));
  process.exitCode = 1;
};

function parse(result: any): any {
  const raw = result?.content?.[0]?.text ?? '{}';
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

const transport = new StdioClientTransport({
  command: 'node',
  args: ['packages/ops-mcp/src/stdio.ts'],
  env: { ...process.env, BROKER_PORT, TARGET_STACK_URL: STACK },
});
const client = new Client({ name: 'blastdoor-e2e', version: '0.1.0' });
await client.connect(transport);

// Reset and set the scene.
await fetch(`${STACK}/api/reset`, { method: 'POST' });
await fetch(`${STACK}/api/fault/inject`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ faultId: 'checkout-copy' }),
});

console.log('\nBLASTDOOR END-TO-END\n');

// 1 — tools are exposed and read-only investigation works.
const tools = await client.listTools();
console.log(`  ..    ${tools.tools.length} tools exposed`);
const metrics = parse(await client.callTool({ name: 'get_metrics', arguments: { service: 'checkout-api' } }));
metrics.metrics?.[0]?.errorRatePct > 1
  ? ok('read-only investigation returns the injected symptom')
  : fail('expected an elevated error rate on checkout-api', metrics);

// 2 — proposing does not execute.
const proposed = parse(
  await client.callTool({
    name: 'propose_rollback_deploy',
    arguments: {
      service: 'checkout-api',
      deployId: 'dep-9f12',
      rationale: 'Failing checkout traces terminate inside the dep-9f12 code path.',
      evidence: [
        { source: 'traces', claim: 'All failing spans terminate in dep-9f12 code.', strength: 'causal' },
        { source: 'metrics', claim: 'Error rate rose at the dep-9f12 rollout.', strength: 'correlational' },
      ],
    },
  }),
);

const proposalId = proposed.proposalId;
proposalId ? ok(`proposal created (${proposalId})`) : fail('no proposal returned', proposed);

const deploysAfterPropose = await (await fetch(`${STACK}/api/deploys`)).json();
deploysAfterPropose.deploys.some((d: any) => d.id === 'dep-9f12')
  ? ok('proposing did NOT execute — the deploy is still live')
  : fail('the proposal reached the target system without approval');

// 3 — executing without approval fails.
const noToken = parse(
  await client.callTool({
    name: 'execute_approved_action',
    arguments: { proposalId, approvalToken: 'tok_madeup' },
  }),
);
noToken.ok === false ? ok('execution without a valid token is refused') : fail('unapproved execution succeeded', noToken);

// 4 — a token is bound to the arguments it was approved for.
const approval = await (
  await fetch(`${BROKER}/api/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ proposalId, decidedBy: 'e2e-operator', note: 'Approved for the e2e check.' }),
  })
).json();
approval.token ? ok('human approval issued a token') : fail('approval did not issue a token', approval);

// Approve a second, different proposal, then try to redeem its token against the first.
const other = parse(
  await client.callTool({
    name: 'propose_restart_service',
    arguments: {
      service: 'catalog-api',
      rationale: 'Unrelated action, used to test token binding.',
      evidence: [{ source: 'metrics', claim: 'Memory climbing.', strength: 'causal' }],
    },
  }),
);
const otherApproval = await (
  await fetch(`${BROKER}/api/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ proposalId: other.proposalId, decidedBy: 'e2e-operator' }),
  })
).json();

const crossed = parse(
  await client.callTool({
    name: 'execute_approved_action',
    arguments: { proposalId, approvalToken: otherApproval.token },
  }),
);
crossed.ok === false
  ? ok("a token from another proposal cannot be redeemed")
  : fail('token from a different proposal was accepted', crossed);

// 5 — the real path works, and the symptom clears.
const executed = parse(
  await client.callTool({
    name: 'execute_approved_action',
    arguments: { proposalId, approvalToken: approval.token },
  }),
);
executed.ok ? ok('approved execution succeeds') : fail('approved execution failed', executed);

const after = await (await fetch(`${STACK}/api/metrics?service=checkout-api`)).json();
after.metrics[0].errorRatePct < 1
  ? ok(`symptom cleared (checkout-api error rate now ${after.metrics[0].errorRatePct}%)`)
  : fail('symptom did not clear', after.metrics[0]);

// 6 — a used token cannot be replayed.
const replay = parse(
  await client.callTool({
    name: 'execute_approved_action',
    arguments: { proposalId, approvalToken: approval.token },
  }),
);
replay.ok === false ? ok('an approval token is single use') : fail('token replay succeeded', replay);

console.log('');
await client.close();
process.exit(process.exitCode ?? 0);
