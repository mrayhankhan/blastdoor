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
import { copyFile, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const REVERT = process.argv.includes("--revert");

const HOOK =
  '      import: async (f) => import((await import("node:url")).pathToFileURL(f).href),\n';

/**
 * Work out where npm's cache actually lives.
 *
 * Guessing the two default locations is wrong for anyone who has moved the cache, and on
 * such a machine the bundle sits somewhere this never looks: the search finds nothing, the
 * script says "nothing to patch", the harness starts unpatched and still dies on Windows —
 * and the recovery instructions then send you back to a command looking in the same wrong
 * places.
 *
 * `npm config get cache` is not usable here: npm treats `cache` as a protected option and
 * refuses to print it. So read the environment override directly, and otherwise ask for the
 * whole resolved config, which does include it.
 */
async function npmCacheRoot(): Promise<string | null> {
  if (process.env.npm_config_cache) return process.env.npm_config_cache;

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  try {
    const { stdout } = await promisify(execFile)("npm", ["config", "ls", "--json"], {
      shell: process.platform === "win32",
    });
    const cache = JSON.parse(stdout)?.cache;
    return typeof cache === "string" && cache ? cache : null;
  } catch {
    return null;
  }
}

/** Find every copy of the bundle npx may have cached. */
async function findBundles(): Promise<string[]> {
  const configured = await npmCacheRoot();

  const roots = [
    // What npm itself reports, first — that is the one that is actually right.
    ...(configured ? [join(configured, "_npx")] : []),
    join(homedir(), "AppData", "Local", "npm-cache", "_npx"),
    join(homedir(), ".npm", "_npx"),
  ];

  const found: string[] = [];
  // The configured cache is usually one of the defaults, so the same directory can appear
  // twice; dedupe so one bundle is not found and patched once per alias.
  for (const root of [...new Set(roots)]) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = join(
        root,
        entry,
        "node_modules",
        "@truefoundry",
        "trueforge",
        "dist",
        "main.js",
      );
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
  // Nothing downloaded yet is not a failure — there is simply nothing to patch. This must
  // exit 0: `npm run harness` is `this && npx trueforge`, so a non-zero exit here stops npx
  // from ever downloading the bundle, and the harness could never start on a fresh machine.
  // The download happens next; on Windows that first run is the unpatched one.
  console.log(
    "No TrueForge bundle cached yet — nothing to patch. npx will download it now.",
  );
  if (platform() === "win32") {
    console.log(
      "On Windows that first run will fail (issue #427). When it does:",
    );
    console.log(
      "  npm run patch:trueforge   # the bundle now exists, so this can patch it",
    );
    console.log("  npm run harness           # starts normally from here on");
  }
} else if (platform() !== "win32" && !REVERT) {
  console.log(
    `Nothing to do on ${platform()} — this patch only matters on Windows.`,
  );
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

    const source = await readFile(bundle, "utf8");
    if (source.includes("pathToFileURL(f).href")) {
      console.log(`already patched  ${bundle}`);
      continue;
    }

    // Keep an original so --revert is always possible.
    try {
      await stat(backup);
    } catch {
      await copyFile(bundle, backup);
    }

    const patched = source.replace(
      /(provider: new FileMigrationProvider2?\(\{\n)/g,
      `$1${HOOK}`,
    );
    const sites = (patched.match(/pathToFileURL\(f\)\.href/g) ?? []).length;

    if (sites === 0) {
      console.log(
        `could not locate the migration provider in ${bundle} — TrueForge may have changed.`,
      );
      process.exitCode = 1;
      continue;
    }

    await writeFile(bundle, patched);
    console.log(`patched ${sites} site(s)  ${bundle}`);
  }

  if (!REVERT && process.exitCode !== 1) {
    console.log("\nTrueForge should now start. Run: npm run harness");
  }
}
