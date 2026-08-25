/**
 * Assemble the static console for public hosting.
 *
 * Locally the console server resolves /vendor/* out of node_modules so there is no build
 * step; static hosting has no server to do that, so this copies the same files into a
 * plain directory. It is the only build in the project and it exists solely because
 * static hosts cannot run the resolution logic — the local developer experience is
 * unchanged.
 *
 *   node scripts/build-static.ts
 */
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.vercel-static');
const CONSOLE_SRC = join(ROOT, 'packages', 'console', 'src');
const THREE_BUILD = join(ROOT, 'node_modules', 'three', 'build');

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'vendor'), { recursive: true });

// Console sources, minus the local dev server which has no role here.
for (const entry of await readdir(CONSOLE_SRC, { withFileTypes: true })) {
  if (!entry.isFile() || entry.name === 'serve.ts') continue;
  await cp(join(CONSOLE_SRC, entry.name), join(OUT, entry.name));
}

// Only the module graph the import map actually reaches.
for (const name of ['three.module.js', 'three.core.js']) {
  await cp(join(THREE_BUILD, name), join(OUT, 'vendor', name));
}

const files = await readdir(OUT, { recursive: true });
console.log(`[build-static] ${OUT}`);
for (const f of files.sort()) console.log(`  ${f}`);
