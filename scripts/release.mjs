// `npm run release`: one release from the external configuration. Guard, setup with MAILSTACK_CONFIG (and
// MAILSTACK_PRO_PATH), migration manifest check, remote D1 migrations, then the deploy of the same files.
// No example generator may run in between: the manifest is checked again right before the deploy.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkRepositories, deploy } from "./deploy-guard.mjs";
import { loadEnv } from "./env.ts";

const CORE = ["0001_initial.sql", "0002_ses_status.sql", "0004_jobs.sql", "0005_ext.sql", "0006_domain_events.sql"];

/** File -> sha256 of every generated migration; refuses a set that does not match the configuration. */
export function migrationManifest(cwd, { pro, extension }) {
  const dir = resolve(cwd, ".wrangler/migrations");
  const files = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
    .map((f) => [f, createHash("sha256").update(readFileSync(resolve(dir, f))).digest("hex")]));
  const missing = [...CORE, ...pro ? ["0003_pro_license_cache.sql"] : []].filter((f) => !files[f]);
  if (missing.length) throw new Error(`Migration manifest is missing ${missing.join(", ")}; run the release setup again.`);
  if (!pro && files["0003_pro_license_cache.sql"]) throw new Error("Migration manifest has Pro migrations without MAILSTACK_PRO_PATH.");
  if (extension && !Object.keys(files).some((f) => /^\d+_ext_.+\.sql$/.test(f)))
    throw new Error("Migration manifest has no extension migrations for the configured mailstack-pro extension.");
  return files;
}

export async function release({
  cwd = process.cwd(), env = loadEnv(cwd),
  run = (cmd, args) => { // setup reads MAILSTACK_CONFIG from its environment, so a value from .env is passed on
    const result = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, MAILSTACK_CONFIG: env.MAILSTACK_CONFIG } });
    if (result.error || result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed.`);
  },
  guard = checkRepositories, deployRelease = (proPath) => deploy({ cwd, proPath }), log = console.log,
} = {}) {
  const config = env.MAILSTACK_CONFIG?.trim(), proPath = env.MAILSTACK_PRO_PATH?.trim() || undefined;
  if (!config) throw new Error("MAILSTACK_CONFIG must name the external configuration.");
  const json = JSON.parse(readFileSync(config, "utf8"));
  const extension = (json.extensions ?? []).some((e) => e.module === "mailstack-pro");
  if ((extension || json.clients) && !proPath) throw new Error("The configuration needs Mailstack Pro; set MAILSTACK_PRO_PATH.");
  guard(cwd, proPath);
  run("npm", ["run", "setup"]);
  const manifest = JSON.stringify(migrationManifest(cwd, { pro: !!proPath, extension }));
  log(`Migration manifest: ${manifest}`);
  run("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--remote"]);
  if (JSON.stringify(migrationManifest(cwd, { pro: !!proPath, extension })) !== manifest)
    throw new Error("Migrations changed after they were applied; deploy refused.");
  await deployRelease(proPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await release(); } catch (error) {
    console.error(`[release] ${error.message}`);
    process.exitCode = 1;
  }
}
