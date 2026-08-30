/**
 * Drive the demo end to end, paced for recording.
 *
 * Live demos fail on camera when they depend on typing accurately under pressure. This
 * runs the whole story against the real MCP server and the real broker, so the only thing
 * left to do while recording is narrate and press Enter.
 *
 * Scenes advance on a keypress rather than a timer. Narration never runs to the second,
 * and a timed driver races ahead — showing the sandbox result while the voiceover is still
 * on the rejection card. The presenter sets the pace; the terminal follows.
 *
 *   npm run stack        # terminal 1
 *   npm run mcp          # terminal 2
 *   npm run console      # terminal 3, then open http://localhost:4100
 *   node scripts/demo-drive.ts
 *
 * Pass --fast to run straight through when rehearsing.
 */
import { createInterface } from 'node:readline/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const STACK = process.env.TARGET_STACK_URL ?? 'http://localhost:4000';
const MCP = process.env.OPS_MCP_URL ?? 'http://localhost:4300/mcp';
const FAST = process.argv.includes('--fast');

const rl = createInterface({ input: process.stdin, output: process.stdout });

/**
 * Wait for the presenter before revealing the next scene.
 *
 * This used to be a timer, which was wrong: narration never runs to the second, so the
 * terminal would race ahead and show scene 3's output while the voiceover was still on
 * scene 2. Advancing on a keypress means the on-screen timeline cannot drift from what is
 * being said, however long a sentence takes.
 */
async function cue(prompt = 'press Enter to continue'): Promise<void> {
  if (FAST) return;
  await rl.question(`\n    [ ${prompt} ]`);
}

function say(line: string): void {
  console.log(`\n${line}`);
}

function parse(result: any): any {
  try {
    return JSON.parse(result?.content?.[0]?.text ?? '{}');
  } catch {
    return {};
  }
}

const client = new Client({ name: 'blastdoor-demo', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(MCP)));

// ── Scene 1: a healthy estate, then an incident ────────────────────────────────
say('[1/5] Resetting the estate and injecting the payment-timeout fault.');
await fetch(`${STACK}/api/reset`, { method: 'POST' });
await fetch(`${STACK}/api/fault/inject`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ faultId: 'payment-timeout' }),
});
await cue();

const metrics = parse(await client.callTool({ name: 'get_metrics', arguments: {} }));
console.table(
  metrics.metrics
    .filter((m: any) => m.errorRatePct > 1)
    .map((m: any) => ({ service: m.service, errorRate: `${m.errorRatePct}%`, p99: `${m.p99LatencyMs}ms` })),
);
say('    The gradient points back to payments-svc. Checkout and the gateway are downstream.');
await cue('Enter when you have introduced the incident');

// ── Scene 2: the obvious rollback, refused ─────────────────────────────────────
say('[2/5] The agent proposes the obvious rollback, on timing evidence alone.');
const bad = parse(
  await client.callTool({
    name: 'propose_rollback_deploy',
    arguments: {
      service: 'payments-svc',
      deployId: 'dep-4c21',
      rationale:
        'Payment failures began about six minutes after dep-4c21 landed, and that deploy raised the ' +
        'provider timeout from 2s to 4s.',
      evidence: [
        {
          source: 'deploys',
          claim: 'dep-4c21 landed at 13:42; error rate crossed threshold at 13:48.',
          strength: 'correlational',
          investigator: 'deploy-hypothesis',
        },
        {
          source: 'metrics',
          claim: 'payments-svc error rate went from 0.4% to 11.2%.',
          strength: 'correlational',
          investigator: 'deploy-hypothesis',
        },
      ],
    },
  }),
);
console.log(`\n    verdict: ${bad.recommendation.toUpperCase()}`);
console.log(`    ${bad.headline}`);
say('    >>> Look at the console. It is not executed, and it never will be on this evidence.');
await cue('Enter AFTER you have walked the rejection card');

// ── Scene 3: the sandbox turns correlation into cause ──────────────────────────
//
// Same incident throughout. The agent does not go and find an easier target — it goes and
// gets the evidence the rejection told it was missing, which is the behaviour the skill
// asks for and the thing the confidence score is designed to reward.
say('[3/5] Subagents delegate, and the sandbox replays the request against both deploys.');
const suspect = await (
  await fetch(`${STACK}/api/replay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service: 'payments-svc', deployId: 'dep-4c21', requestShape: 'card settlement' }),
  })
).json();
const baseline = await (
  await fetch(`${STACK}/api/replay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service: 'payments-svc', deployId: 'dep-3b90', requestShape: 'card settlement' }),
  })
).json();
console.log(`    dep-4c21 (suspect)     -> ${suspect.outcome.toUpperCase()}`);
console.log(`    dep-3b90 (predecessor) -> ${baseline.outcome.toUpperCase()}`);
say('    Fail then pass. That is causal evidence, and no amount of metric-reading gets you there.');
await cue('Enter when you have called out fail-then-pass');

// ── Scene 4: the same action, now with proof — and still irreversible ──────────
say('[4/5] Re-proposing the SAME rollback, now backed by the replay.');
const good = parse(
  await client.callTool({
    name: 'propose_rollback_deploy',
    arguments: {
      service: 'payments-svc',
      deployId: 'dep-4c21',
      rationale:
        'Sandbox replay fails on dep-4c21 and passes on dep-3b90, and every failing settlement trace ' +
        'terminates in the new timeout path. The migration still makes this a one-way door.',
      evidence: [
        {
          source: 'sandbox-replay',
          claim: 'card settlement fails on dep-4c21, passes on dep-3b90.',
          strength: 'causal',
          investigator: 'deploy-hypothesis',
        },
        {
          source: 'traces',
          claim: 'Every failing settlement span terminates in the dep-4c21 provider-timeout path.',
          strength: 'causal',
          investigator: 'dependency-hypothesis',
        },
        {
          source: 'logs',
          claim: 'Provider timeout log volume tracks the dep-4c21 rollout window.',
          strength: 'correlational',
          investigator: 'dependency-hypothesis',
        },
      ],
    },
  }),
);
console.log(`\n    verdict: ${good.recommendation.toUpperCase()}`);
console.log(`    ${good.headline}`);
say('    Confidence cleared the bar, but the migration means this is still irreversible —');
say('    so the console makes you HOLD the button rather than click it.');
console.log(`\n    >>> Hold to approve in the console, then paste the token here.`);
console.log(`    proposal: ${good.proposalId}`);

// ── Scene 5: wait for the human, then execute ──────────────────────────────────
const token = (await rl.question('\n    token: ')).trim();

say('[5/5] Executing with the human-issued token.');
const executed = parse(
  await client.callTool({
    name: 'execute_approved_action',
    arguments: { proposalId: good.proposalId, approvalToken: token },
  }),
);
console.log(`    ${executed.ok ? 'EXECUTED' : 'REFUSED'} — ${executed.result ?? executed.error}`);

await new Promise((r) => setTimeout(r, 1500));
const after = await (await fetch(`${STACK}/api/metrics?service=checkout-api`)).json();
console.log(`    checkout-api error rate is now ${after.metrics[0].errorRatePct}%`);
say('Done.');

rl.close();
await client.close();
process.exit(0);
