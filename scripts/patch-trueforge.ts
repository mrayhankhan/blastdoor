/**
 * Make TrueForge 0.1.4 start on Windows.
 *
 * Kysely's FileMigrationProvider joins the migrations folder and filename into an OS path
 * and `import()`s it directly. On Windows that is `C:\…`, which Node's ESM loader rejects
 * with ERR_UNSUPPORTED_ESM_URL_SCHEME, so the harness dies during startup migrations
 * before the agent server ever listens. Upstream issue: truefoundry/trueforge#427.
 *
 * The provider accepts an `import` hook for exactly this case. This patches the installed
 * bundle to use it, so a judge on Windows can run the project without waiting for a
 * release. The same fix is submitted upstream as a source patch; this is the local
 * equivalent applied to whatever npx already downloaded.
 *
 *   node scripts/patch-trueforge.ts            # apply
 *   node scripts/patch-trueforge.ts --revert   # restore the original
 *
 * A no-op on macOS and Linux, where the joined path already resolves.
 */
import { copyFile, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const REVERT = process.argv.includes('--revert');

const HOOK =
  '      import: async (f) => import((await import("node:url")).pathToFileURL(f).href),\n';

/** Find every copy of the bundle npx may have cached. */
async function findBundles(): Promise<string[]> {
  const roots = [
    join(homedir(), 'AppData', 'Local', 'npm-cache', '_npx'),
    join(homedir(), '.npm', '_npx'),
  ];

  const found: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = join(root, entry, 'node_modules', '@truefoundry', 'trueforge', 'dist', 'main.js');
      try {
        await stat(candidate);
        found.push(candidate);
      } catch {
        /* not this one */
      }
    }
  }
  return found;
}

const bundles = await findBundles();

if (bundles.length === 0) {
  console.log('No cached TrueForge bundle found. Run `npm run harness` once, then re-run this.');
  process.exitCode = 1;
} else if (platform() !== 'win32' && !REVERT) {
  console.log(`Nothing to do on ${platform()} — this patch only matters on Windows.`);
} else {
  for (const bundle of bundles) {
    const backup = `${bundle}.orig`;

    if (REVERT) {
      try {
        await copyFile(backup, bundle);
        console.log(`reverted  ${bundle}`);
      } catch {
        console.log(`no backup  ${bundle}`);
      }
      continue;
    }

    const source = await readFile(bundle, 'utf8');
    if (source.includes('pathToFileURL(f).href')) {
      console.log(`already patched  ${bundle}`);
      continue;
    }

    // Keep an original so --revert is always possible.
    try {
      await stat(backup);
    } catch {
      await copyFile(bundle, backup);
    }

    const patched = source.replace(/(provider: new FileMigrationProvider2?\(\{\n)/g, `$1${HOOK}`);
    const sites = (patched.match(/pathToFileURL\(f\)\.href/g) ?? []).length;

    if (sites === 0) {
      console.log(`could not locate the migration provider in ${bundle} — TrueForge may have changed.`);
      process.exitCode = 1;
      continue;
    }

    await writeFile(bundle, patched);
    console.log(`patched ${sites} site(s)  ${bundle}`);
  }

  if (!REVERT && process.exitCode !== 1) {
    console.log('\nTrueForge should now start. Run: npm run harness');
  }
}
