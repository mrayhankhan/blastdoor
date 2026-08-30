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
// types natively *without a flag* — the scripts are invoked as plain `node scripts/x.ts`.
// That became the default in 22.18 and 23.6, not at 22.0: the whole 22.0–22.17 range
// satisfies a documented "Node 22+" and still cannot load a single file in this repo.
const [major, minor] = process.versions.node.split('.').map(Number);
const stripsTypes = major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
record(
  stripsTypes
    ? { ok: true, label: `Node ${process.versions.node}` }
    : {
        ok: false,
        label: `Node ${process.versions.node} cannot run this repo`,
        detail:
          'Needs 22.18+ or 23.6+, where Node strips TypeScript types with no flag. That is how this repo runs with no build step.',
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
    // Port 0 is rejected rather than treated as valid: it tells Node to pick an ephemeral
    // port, so the service comes up somewhere nothing else can find it. Binding it would
    // succeed and report ":0 free", which is true and useless.
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
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
    wiring: { env: 'TARGET_STACK_URL', url: (p) => `http://localhost:${p}`, path: '/', used: 'ops-mcp and the e2e suite' },
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
    // The console resolves the broker in the browser, not from the environment, so there is
    // no variable preflight can check — only a warning it can raise.
    wiring: { browser: 'window.BLASTDOOR_BROKER', used: 'the console' },
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
    wiring: { env: 'OPS_MCP_URL', url: (p) => `http://localhost:${p}/mcp`, path: '/mcp', used: 'provisioning and the demo driver' },
  },
];

// Resolve every port first. Two services pointed at the same port each probe it, find it
// free, release it, and both pass — then the second one to actually start dies on
// EADDRINUSE. Probing in isolation cannot see that, so it is checked across the set.
const resolved = ports.map((spec) => ({
  ...spec,
  port: Number(process.env[spec.env] ?? spec.fallback),
}));

const seen = new Map();
for (const { port, env, name } of resolved) {
  // Only real ports can collide. Malformed settings all coerce to NaN, and a Map treats
  // every NaN key as the same key — so two unrelated typos would otherwise be reported as
  // sharing ":NaN", on top of the invalid-port failure each one already earns below.
  if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
  const prior = seen.get(port);
  if (prior) {
    record({
      ok: false,
      label: `:${port} is assigned to both ${prior.name} and ${name}`,
      detail: `They cannot share it. Change ${env} or ${prior.env}.`,
    });
  } else {
    seen.set(port, { env, name });
  }
}

for (const { env, fallback, name, probe, marker, port } of resolved) {
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
      detail: `Got ${process.env[env]}. Set ${env} to a whole number between 1 and 65535.`,
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

// 4 — Wiring. Moving a service is only half the job: its dependents resolve it from a
// separate variable that still points at the old default. Without this, taking the advice
// above ("set X to a free port") produces a preflight that passes and a stack that cannot
// talk to itself.
for (const { env, fallback, name, port, wiring } of resolved) {
  if (!wiring || port === fallback) continue;

  if (wiring.browser) {
    record({
      ok: false,
      label: `${name} moved to :${port} — ${wiring.used} still on :${fallback}`,
      detail: `${wiring.browser} is resolved in the browser, so it cannot be set from the environment. Serve the console with it set, or leave ${env} alone.`,
    });
    continue;
  }

  const expected = wiring.url(port);
  const actual = process.env[wiring.env];

  // Compare the port the dependent will actually dial, not the exact string. A stack wired
  // with http://127.0.0.1:4001 is correct, and rejecting it for not matching the localhost
  // spelling would fail a working configuration.
  // The port is what a dependent dials, but not all of what it needs: ops-mcp is only
  // reachable at /mcp, so a URL on the right port and the wrong path is still broken.
  // Compare both, and keep host spelling out of it.
  let points = null;
  let path = null;
  if (actual) {
    try {
      const u = new URL(actual);
      points = u.port || (u.protocol === 'https:' ? '443' : '80');
      path = u.pathname.replace(/\/$/, '') || '/';
    } catch {
      points = null;
    }
  }

  const wantPath = wiring.path.replace(/\/$/, '') || '/';
  const portOk = points === String(port);
  const pathOk = path === wantPath;

  record(
    portOk && pathOk
      ? { ok: true, label: `${wiring.env} follows ${env}` }
      : {
          ok: false,
          label: !actual
            ? `${name} moved to :${port} — ${wiring.used} still on :${fallback}`
            : !portOk
              ? `${wiring.env} points at :${points ?? '?'}, but ${name} is on :${port}`
              : `${wiring.env} points at ${path}, but ${name} serves ${wantPath}`,
          detail: `Set ${wiring.env}=${expected}`,
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
