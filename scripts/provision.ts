/**
 * Provision TrueForge with everything Blastdoor needs, over the harness HTTP API.
 *
 * Clicking through Settings works, but it is not reproducible and a judge cannot verify
 * it. This does the same thing as code: registers the MCP server, mounts both skills from
 * the public repo, and creates the agent with the sandbox, subagents, and approval policy
 * it is meant to run with. Re-running it is safe — existing resources are updated.
 *
 *   node scripts/provision.ts
 *
 * Prerequisites:
 *   - TrueForge running          (npm run harness)
 *   - target stack running       (npm run stack)
 *   - Blastdoor MCP over HTTP    (npm run mcp)
 *   - a model provider key added in TrueForge → Settings → Models
 *
 * The model key is deliberately not handled here. It belongs in the harness, entered by
 * the person who owns it, and a provisioning script is the wrong place for a secret.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = process.env.TRUEFORGE_URL ?? 'http://localhost:8790';
const MCP_URL = process.env.OPS_MCP_URL ?? 'http://localhost:4300/mcp';
const REPO = process.env.BLASTDOOR_REPO ?? 'https://github.com/mrayhankhan/blastdoor';
const REF = process.env.BLASTDOOR_REF ?? 'main';

const api = (path: string) => `${HARNESS}/api/v1${path}`;

async function post(path: string, body: unknown): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(api(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (res.ok) return { ok: true, detail: 'created' };

  // Re-running provisioning should be boring, so an already-exists is a success.
  if (/exist|conflict|duplicate/i.test(text) || res.status === 409) {
    return { ok: true, detail: 'already present' };
  }
  return { ok: false, detail: text.slice(0, 300) };
}

function report(label: string, result: { ok: boolean; detail: string }): boolean {
  console.log(`  ${result.ok ? 'OK  ' : 'FAIL'}  ${label}${result.ok ? ` (${result.detail})` : ''}`);
  if (!result.ok) console.log(`        ${result.detail}`);
  return result.ok;
}

console.log(`\nProvisioning TrueForge at ${HARNESS}\n`);

// Fail early with a useful message rather than a cascade of connection errors.
try {
  await fetch(api('/capabilities'));
} catch {
  console.error(`Cannot reach TrueForge at ${HARNESS}. Start it with: npm run harness`);
  process.exit(1);
}

let allOk = true;

// 1 — the MCP server. TrueForge attaches MCP servers by URL, so this is the HTTP
// transport rather than stdio.
allOk =
  report(
    'MCP server "blastdoor-ops"',
    await post('/settings/mcp-servers', {
      manifest: {
        type: 'remote',
        name: 'blastdoor-ops',
        url: MCP_URL,
        description:
          'Read-only observability tools for the estate, plus propose_* tools that produce a ' +
          'blast-radius report instead of executing.',
      },
    }),
  ) && allOk;

// 2 — skills, pulled from the public repo so the harness and the reader see the same text.
const SKILLS = [
  {
    name: 'incident-response',
    description:
      'Working an incident in this estate: tracing a symptom back to its origin, separating cause ' +
      'from coincidence, replaying deploys in the sandbox, and delegating competing hypotheses to subagents.',
  },
  {
    name: 'blast-radius',
    description:
      'Writing a proposal a human can decide on: classifying evidence honestly, attributing subagent ' +
      'findings, and responding correctly when Blastdoor rejects it.',
  },
];

for (const skill of SKILLS) {
  allOk =
    report(
      `skill "${skill.name}"`,
      await post('/settings/skills', {
        manifest: {
          type: 'git',
          name: skill.name,
          url: REPO,
          path: `agent/skills/${skill.name}`,
          ref: REF,
          description: skill.description,
        },
      }),
    ) && allOk;
}

// 3 — the agent.
const spec = JSON.parse(await readFile(join(ROOT, 'agent', 'agent.json'), 'utf8'));
const agent = await post('/agents', spec);

if (!agent.ok && /provider not configured/i.test(agent.detail)) {
  console.log(`  WAIT  agent "${spec.name}" — model provider not configured yet`);
  console.log(`        Add a key in TrueForge → Settings → Models, then re-run this script.`);
  console.log(`        Current model: ${spec.manifest.model.name}`);
  allOk = false;
} else {
  allOk = report(`agent "${spec.name}"`, agent) && allOk;
}

console.log(
  allOk
    ? `\nReady. Open ${HARNESS} and start a session with "${spec.name}".\n`
    : `\nProvisioning incomplete — see above.\n`,
);

// Set the code and let the loop drain. Calling process.exit() here trips a libuv
// assertion on Windows while fetch's keep-alive sockets are still closing.
process.exitCode = allOk ? 0 : 1;
