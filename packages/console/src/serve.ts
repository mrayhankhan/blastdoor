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

createServer(async (req, res) => {
  const requested = (req.url ?? '/').split('?')[0];
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
