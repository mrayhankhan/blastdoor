/**
 * Check that this machine can actually run Blastdoor, and say what to do about it if not.
 *
 * The repo asks a stranger to hold four processes open at once. Every way that goes wrong —
 * a Node old enough that TypeScript needs a build step, a port already taken by something
 * unrelated, an `npm install` that never happened — surfaces as a different error from a
 * different process, and none of them name the actual problem. This names it once, up front.
 *
 *   node scripts/preflight.mjs
 *
 * Deliberately plain JavaScript, unlike every other script here. Its first job is to tell you
 * your Node is too old to run the TypeScript in this repo, and it cannot do that from a `.ts`
 * file: the runtime that cannot strip types fails while *loading* the checker, with the same
 * opaque syntax error the checker exists to explain.
 *
 * Exits non-zero if anything would stop the stack from coming up, so it is also usable as a
 * gate in CI.
 */
import { createServer } from 'node:net';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {{ ok: boolean, label: string, detail?: string }} Check */

/** @type {Check[]} */
const results = [];

/** @param {Check} c */
const record = (c) => {
  results.push(c);
  console.log(`  ${c.ok ? 'OK  ' : 'FAIL'}  ${c.label}`);
  if (c.detail) console.log(`        ${c.detail}`);
};

console.log('\nBLASTDOOR PREFLIGHT\n');

// 1 — Node. The repo runs TypeScript with no build step, which needs a runtime that strips
// types natively. Below 22 nothing else in this list matters. 22.6 is where `--experimental-
// strip-types` landed; the 22.0–22.5 range satisfies '22+' but still cannot load a .ts file.
const [major, minor] = process.versions.node.split('.').map(Number);
const stripsTypes = major > 22 || (major === 22 && minor >= 6);
record(
  stripsTypes
    ? { ok: true, label: `Node ${process.versions.node}` }
    : {
        ok: false,
        label: `Node ${process.versions.node} cannot run this repo`,
        detail:
          'Node 22.6+ strips TypeScript types natively, which is how this repo runs with no build step.',
      },
);

// 2 — Dependencies. `npm run stack` fails deep inside a module resolution error otherwise,
// which reads like a bug in the project rather than a missing install.
// fileURLToPath, not URL.pathname — on Windows the latter yields `/C:/…`, which does not
// join into a real path. This repo ships a Windows patch, so it has Windows users.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const installed = await stat(join(root, 'node_modules', '@modelcontextprotocol')).then(
  () => true,
  () => false,
);
record(
  installed
    ? { ok: true, label: 'dependencies installed' }
    : { ok: false, label: 'dependencies missing', detail: 'Run: npm install' },
);

/**
 * Try to bind the port, and report what happened rather than just 'free or not'.
 *
 * The probe binds the wildcard rather than 127.0.0.1, because that is what the servers in
 * this repo do. Node sets SO_REUSEADDR on every listener, so a probe bound to one specific
 * address binds happily alongside a wildcard listener that already holds the port — and the
 * check would then report 'free' for a port that is very much taken.
 *
 * Only a successful listen proves a port is available. EADDRINUSE means occupied; anything
 * else (EACCES on a privileged port, EMFILE when the process is out of descriptors) means
 * the real server will not bind either, so it is reported as its own failure instead of
 * being quietly rounded down to 'free'.
 *
 * @param {number} port
 * @returns {Promise<{ state: 'free' | 'busy' | 'invalid' | 'error', code?: string }>}
 */
function probeBind(port) {
  return new Promise((resolve) => {
    // A port that is not a usable number never reaches the socket layer — `listen` throws
    // synchronously — so it is checked here rather than caught as an error event.
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      resolve({ state: 'invalid' });
      return;
    }
    const probe = createServer();
    probe.once('error', (/** @type {NodeJS.ErrnoException} */ err) =>
      resolve(
        err.code === 'EADDRINUSE'
          ? { state: 'busy' }
          : { state: 'error', code: err.code ?? String(err) },
      ),
    );
    probe.once('listening', () => probe.close(() => resolve({ state: 'free' })));
    try {
      probe.listen(port);
    } catch (/** @type {any} */ err) {
      resolve({ state: 'error', code: err?.code ?? String(err) });
    }
  });
}

/**
 * Decide whether the thing on this port is ours.
 *
 * A 2xx is not identification — an unrelated server answering 200 on `/` would be waved
 * through, and then the real bring-up hits EADDRINUSE anyway. Each service is matched on a
 * string only its own response carries. The timeout matters just as much: a process that
 * accepts the connection and never sends headers would otherwise leave this pending forever,
 * so preflight would hang instead of reporting the squatter it exists to report.
 *
 * @param {number} port
 * @param {string} path
 * @param {string} marker
 */
async function looksLikeOurs(port, path, marker) {
  try {
    const res = await fetch(`http://localhost:${port}${path}`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    return (await res.text()).includes(marker);
  } catch {
    return false;
  }
}

// 3 — Ports. Occupied is only a problem when it is occupied by something that is not us.
// Each port is read from the same environment variable its server reads, so checking a
// configured deployment does not silently check the defaults instead.
const ports = [
  {
    env: 'TARGET_STACK_PORT',
    fallback: 4000,
    name: 'target-stack',
    probe: '/api/topology',
    marker: '"dependsOn"',
  },
  {
    env: 'CONSOLE_PORT',
    fallback: 4100,
    name: 'console',
    probe: '/',
    marker: 'Blastdoor Console',
  },
  {
    env: 'BROKER_PORT',
    fallback: 4200,
    name: 'broker',
    probe: '/api/proposals',
    marker: '"proposals"',
  },
  // `npm run mcp` serves MCP here and brings the broker up on 4200 alongside it. Probe
  // /health rather than /mcp: the MCP endpoint answers a bare GET with 406 (it wants an
  // SSE Accept header), which would read as 'someone else has this port'.
  {
    env: 'OPS_MCP_PORT',
    fallback: 4300,
    name: 'ops-mcp',
    probe: '/health',
    marker: '"targetStack"',
  },
];

for (const { env, fallback, name, probe, marker } of ports) {
  const port = Number(process.env[env] ?? fallback);
  const configured = port !== fallback ? ` [${env}]` : '';
  const bind = await probeBind(port);

  if (bind.state === 'free') {
    record({ ok: true, label: `:${port} free (${name})${configured}` });
    continue;
  }

  if (bind.state === 'invalid') {
    record({
      ok: false,
      label: `${env} is not a usable port number (${name})`,
      detail: `Got ${process.env[env]}. Set ${env} to a whole number between 0 and 65535.`,
    });
    continue;
  }

  if (bind.state === 'error') {
    record({
      ok: false,
      label: `:${port} cannot be bound — ${bind.code} (${name})${configured}`,
      detail: `The server will hit the same error. Resolve ${bind.code}, or set ${env} to another port.`,
    });
    continue;
  }

  record(
    (await looksLikeOurs(port, probe, marker))
      ? { ok: true, label: `:${port} already serving ${name}${configured}` }
      : {
          ok: false,
          label: `:${port} taken by something else (${name} needs it)${configured}`,
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
console.log('Or see the approval cards immediately, with no harness and no model:\n');
console.log('  npm run demo\n');
