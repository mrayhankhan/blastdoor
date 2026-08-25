/**
 * Static file server for the console. No build step, no bundler — the console is three
 * files a judge can read.
 *
 *   node packages/console/src/serve.ts     # http://localhost:4100
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CONSOLE_PORT ?? 4100);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/** Repo root, so three.js can be served straight out of node_modules. */
const ROOT = join(HERE, '..', '..', '..');

/**
 * Three.js is served straight out of node_modules under /vendor/, rather than copied
 * into the repo or bundled. Keeping the no-build-step property means the browser needs
 * real URLs for its import map, and three.module.js re-exports from three.core.js, so
 * the whole build directory has to be reachable — not just the entry point.
 */
const VENDOR_ROOT = join(ROOT, 'node_modules', 'three', 'build');

createServer(async (req, res) => {
  const requested = (req.url ?? '/').split('?')[0];

  if (requested.startsWith('/vendor/')) {
    const name = requested.slice('/vendor/'.length);
    const path = join(VENDOR_ROOT, name);

    // Same containment rule as the static root below: resolve, then verify it did not
    // escape. A path like /vendor/../../.env must not be readable.
    if (!path.startsWith(VENDOR_ROOT) || !name.endsWith('.js')) {
      res.statusCode = 403;
      res.end('// Forbidden');
      return;
    }

    try {
      const body = await readFile(path);
      res.setHeader('content-type', MIME['.js']);
      res.setHeader('cache-control', 'public, max-age=3600');
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end(`// Not found: ${name}. Run: npm install`);
    }
    return;
  }

  const file = requested === '/' ? 'index.html' : normalize(requested).replace(/^([/\\])+/, '');

  // Keep the server inside its own directory; a static server that will happily read
  // ../../.env is not something to ship even in a demo.
  const path = join(HERE, file);
  if (!path.startsWith(HERE)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  try {
    const body = await readFile(path);
    res.setHeader('content-type', MIME[extname(path)] ?? 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
}).listen(PORT, () => {
  console.log(`[console] http://localhost:${PORT}`);
});
