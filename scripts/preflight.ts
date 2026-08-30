/**
 * Check that this machine can actually run Blastdoor, and say what to do about it if not.
 *
 * The repo asks a stranger to hold three terminals open at once. Every way that goes wrong —
 * a Node old enough that TypeScript needs a build step, a port already taken by something
 * unrelated, an `npm install` that never happened — surfaces as a different error from a
 * different process, and none of them name the actual problem. This names it once, up front.
 *
 *   node scripts/preflight.ts
 *
 * Exits non-zero if anything would stop the stack from coming up, so it is also usable as a
 * gate in CI.
 */
import { createServer } from 'node:net';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Check = { ok: boolean; label: string; detail?: string };

const results: Check[] = [];
const record = (c: Check) => {
  results.push(c);
  console.log(`  ${c.ok ? 'OK  ' : 'FAIL'}  ${c.label}`);
  if (c.detail) console.log(`        ${c.detail}`);
};

console.log('\nBLASTDOOR PREFLIGHT\n');

// 1 — Node. The repo runs TypeScript with no build step, which needs a runtime that strips
// types natively. Below 22 nothing else in this list matters.
const major = Number(process.versions.node.split('.')[0]);
record(
  major >= 22
    ? { ok: true, label: `Node ${process.versions.node}` }
    : {
        ok: false,
        label: `Node ${process.versions.node} is too old`,
        detail:
          'Node 22+ runs the TypeScript in this repo directly. Upgrade, then re-run.',
      },
);

// 2 — Dependencies. `npm run stack` fails deep inside a module resolution error otherwise,
// which reads like a bug in the project rather than a missing install.
// fileURLToPath, not URL.pathname — on Windows the latter yields `/C:/…`, which does not
// join into a real path. This repo ships a Windows patch, so it has Windows users.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const installed = await stat(
  join(root, 'node_modules', '@modelcontextprotocol'),
).then(
  () => true,
  () => false,
);
record(
  installed
    ? { ok: true, label: 'dependencies installed' }
    : { ok: false, label: 'dependencies missing', detail: 'Run: npm install' },
);

/**
 * Resolve true if something is already listening on the port.
 *
 * The probe binds the wildcard rather than 127.0.0.1, because that is what the servers in
 * this repo do. Node sets SO_REUSEADDR on every listener, so a probe bound to one specific
 * address binds happily alongside a wildcard listener that already holds the port — and the
 * check then reports 'free' for a port that is very much taken.
 */
function inUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (err: NodeJS.ErrnoException) =>
      resolve(err.code === 'EADDRINUSE'),
    );
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(port);
  });
}

/** A port held by our own process is fine — that is the README's three-terminal layout. */
async function heldByBlastdoor(port: number, path: string): Promise<boolean> {
  return fetch(`http://localhost:${port}${path}`).then(
    (r) => r.ok,
    () => false,
  );
}

// 3 — Ports. Occupied is only a problem when it is occupied by something that is not us.
const ports = [
  {
    port: 4000,
    name: 'target-stack',
    probe: '/api/topology',
    env: 'TARGET_STACK_PORT',
  },
  { port: 4100, name: 'console', probe: '/', env: 'CONSOLE_PORT' },
  { port: 4200, name: 'broker', probe: '/api/proposals', env: 'BROKER_PORT' },
  // `npm run mcp` serves MCP here and brings the broker up on 4200 alongside it. Probe
  // /health rather than /mcp: the MCP endpoint answers a bare GET with 406 (it wants an
  // SSE Accept header), which would read as 'someone else has this port'.
  { port: 4300, name: 'ops-mcp', probe: '/health', env: 'OPS_MCP_PORT' },
];

for (const { port, name, probe, env } of ports) {
  if (!(await inUse(port))) {
    record({ ok: true, label: `:${port} free (${name})` });
    continue;
  }
  record(
    (await heldByBlastdoor(port, probe))
      ? { ok: true, label: `:${port} already serving ${name}` }
      : {
          ok: false,
          label: `:${port} taken by something else (${name} needs it)`,
          detail: `Stop it, or set ${env} to a free port.`,
        },
  );
}

const failed = results.filter((r) => !r.ok);
console.log('');

if (failed.length > 0) {
  console.log(
    `${failed.length} ${failed.length === 1 ? 'thing' : 'things'} to fix before the stack will come up.\n`,
  );
  process.exit(1);
}

console.log('Ready. Three terminals:\n');
console.log('  npm run stack      # the production estate        :4000');
console.log('  npm run mcp        # MCP :4300 + approval broker  :4200');
console.log('  npm run console    # the approval console         :4100\n');
console.log(
  'Or see the approval cards immediately, with no harness and no model:\n',
);
console.log('  npm run demo\n');
