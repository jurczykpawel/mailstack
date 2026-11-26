// `npm run config:push [-- --yes] [--from <deployed.json>]`: deploy the external configuration with the code that is
// already deployed. The checkout must equal the commits in /health; the deployed configuration is the one bundled by the
// last setup of this checkout (or --from), verified against the `config` SHA-256 in /health.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { checkRepositories, deploy } from "./deploy-guard.mjs";
import { loadEnv } from "./env.ts";
import { changedPaths, changedRenders } from "./config-renders.ts";

const sha = (data) => createHash("sha256").update(data).digest("hex");

export async function configPush({ cwd = process.cwd(), env = loadEnv(cwd), args = process.argv.slice(2), log = console.log,
  guard = checkRepositories, health = async (url) => {
    const response = await fetch(url, { cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Health check failed: HTTP ${response.status}.`);
    return response.json();
  },
  run = (cmd, argv, extra = {}) => {
    const result = spawnSync(cmd, argv, { cwd, stdio: "inherit", env: { ...process.env, ...extra } });
    if (result.error || result.status !== 0) throw new Error(`${cmd} ${argv.join(" ")} failed.`);
  },
  wrangler = (argv) => {
    const result = spawnSync("wrangler", argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    if (result.error || result.status !== 0) throw new Error(`wrangler ${argv.join(" ")} failed.`);
    return result.stdout;
  },
  deployConfig = deploy,
  confirm = async (question) => {
    if (!process.stdin.isTTY) throw new Error("No terminal to confirm; pass --yes.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return /^y(es)?$/i.test((await rl.question(question)).trim()); } finally { rl.close(); }
  } } = {}) {
  const config = env.MAILSTACK_CONFIG?.trim(), proPath = env.MAILSTACK_PRO_PATH?.trim() || undefined, url = env.MAILSTACK_HEALTH_URL?.trim();
  const from = args.includes("--from") ? args[args.indexOf("--from") + 1] : undefined;
  if (!config) throw new Error("MAILSTACK_CONFIG must name the external configuration.");
  if (!url) throw new Error("MAILSTACK_HEALTH_URL must name the deployed /health URL.");
  const { sha: commit, pro } = guard(cwd, proPath, env.MAILSTACK_WORKER_NAME);
  const live = await health(url);
  if (live?.commit !== commit || live?.proCommit !== pro)
    throw new Error("This checkout differs from the deployed commit or Pro commit: that is a code release, not a configuration change (npm run release).");
  if (!/^[0-9a-f]{64}$/.test(live.config ?? "")) throw new Error("The deployed Worker does not report its configuration; release a version with config:push first.");
  // The deployed configuration: the last setup of this checkout, or an explicit copy.
  const bundled = readFileSync(resolve(cwd, "src/core/config/bundled.ts"), "utf8").match(/^export const CONFIG_JSON = (.*);$/m);
  const before = from ? readFileSync(from, "utf8") : bundled && JSON.parse(bundled[1]);
  if (!before || sha(before) !== live.config) throw new Error(`No copy of the deployed configuration (SHA-256 ${live.config}); pass --from <file> with it.`);
  const after = readFileSync(config, "utf8");
  if (sha(after) === live.config) return log("No configuration change; nothing to deploy.");
  run("node", ["scripts/bundle-config.ts", "--check"], { MAILSTACK_CONFIG: config });
  const renders = changedRenders(before, after);
  log(renders.length ? `Changed renders (${renders.length}):\n  ${renders.join("\n  ")}` : "Renders unchanged.");
  log(`Changed configuration paths:\n  ${changedPaths(before, after).join("\n  ") || "(formatting only)"}`);
  if (!args.includes("--yes") && !await confirm("Deploy this configuration? [y/N] ")) return log("Cancelled.");
  // Rollback target: the replaced version must be the newest and only deployed one (it carries the current secrets).
  const deployed = JSON.parse(wrangler(["deployments", "status", "--json"])).versions ?? [];
  const newest = JSON.parse(wrangler(["versions", "list", "--json"])).toSorted((a, b) => a.metadata.created_on.localeCompare(b.metadata.created_on)).at(-1);
  if (deployed.length !== 1 || deployed[0].percentage !== 100 || deployed[0].version_id !== newest?.id)
    throw new Error("The deployed Worker version is not the newest and only one; release first.");
  const previous = deployed[0].version_id;
  const migrations = () => JSON.stringify(readdirSync(resolve(cwd, ".wrangler/migrations")).sort().map((f) => [f, sha(readFileSync(resolve(cwd, ".wrangler/migrations", f)))]));
  const schema = migrations();
  const restore = () => { // setup again from the deployed configuration, so this checkout keeps matching the Worker
    const dir = mkdtempSync(join(tmpdir(), "mailstack-config-")), copy = join(dir, "mailstack.json");
    try { writeFileSync(copy, before, { mode: 0o600 }); run("npm", ["run", "setup"], { MAILSTACK_CONFIG: copy }); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  run("npm", ["run", "setup"], { MAILSTACK_CONFIG: config });
  if (migrations() !== schema) { restore(); throw new Error("The configuration changes the database schema; use npm run release."); }
  try {
    await deployConfig({ cwd, proPath, workerName: env.MAILSTACK_WORKER_NAME, healthUrl: url, configSha: sha(after) });
  } catch (error) {
    wrangler(["rollback", previous, "--message", "config:push failed", "--yes"]);
    restore();
    throw new Error(`${error.message} Deploy rolled back to ${previous}.`);
  }
  log(`Configuration ${sha(after)} deployed.`);
  const hook = env.MAILSTACK_CONFIG_POST_PUSH?.trim();
  if (hook) try { run(hook, [config]); } catch (error) { log(`Warning: post-push hook failed: ${error.message}`); }
}

if (import.meta.main) await configPush().catch((error) => { console.error(`[config:push] ${error.message}`); process.exitCode = 1; });
