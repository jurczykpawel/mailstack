// `npm run release`: guard, setup from MAILSTACK_CONFIG (+ MAILSTACK_PRO_PATH), migration manifest check, remote D1
// migrations, manifest recheck (no example generator in between), then the deploy of the same files.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { checkRepositories, deploy } from "./deploy-guard.mjs";
import { loadEnv } from "./env.ts";
import { compileMigrations, migrationFile } from "../src/core/ext-migrations.ts";

const sha = (data) => createHash("sha256").update(data).digest("hex");
const CORE = ["0001_initial.sql", "0002_ses_status.sql", "0004_jobs.sql", "0005_ext.sql", "0006_domain_events.sql", "0007_partial_indexes.sql", "0008_without_rowid.sql"];

/** Extension migration file -> sha256 that setup compiles for this configuration; none without a Pro schema (e.g. no webhooks). */
export async function extensionManifest(json, proPath) {
  const entry = (json.extensions ?? []).find((e) => e.module === "mailstack-pro");
  const { workerMigrations } = entry && proPath ? await import(resolve(realpathSync(proPath), "src/worker.ts")) : {};
  const ext = typeof workerMigrations === "function" ? workerMigrations(entry.options ?? {}) : undefined;
  return Object.fromEntries((ext ? await compileMigrations(ext.name, ext.migrations) : []).map((m) => [m.file, sha(migrationFile(m))]));
}

/** File -> sha256 of every generated migration; refuses a set that does not match the configuration. */
export function migrationManifest(cwd, { pro, extension = {} }) {
  const dir = resolve(cwd, ".wrangler/migrations");
  const files = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
    .map((f) => [f, sha(readFileSync(resolve(dir, f)))]));
  const missing = [...CORE, ...pro ? ["0003_pro_license_cache.sql"] : []].filter((f) => !files[f]);
  if (missing.length) throw new Error(`Migration manifest is missing ${missing.join(", ")}; run the release setup again.`);
  if (!pro && files["0003_pro_license_cache.sql"]) throw new Error("Migration manifest has Pro migrations without MAILSTACK_PRO_PATH.");
  const ext = Object.keys(files).filter((f) => /^\d+_ext_.+\.sql$/.test(f));
  if (ext.length !== Object.keys(extension).length || ext.some((f) => files[f] !== extension[f]))
    throw new Error("Migration manifest does not match the extension migrations of this configuration.");
  return JSON.stringify(files);
}

export async function release({ cwd = process.cwd(), env = loadEnv(cwd), guard = checkRepositories, log = console.log,
  run = (cmd, args) => { // setup reads MAILSTACK_CONFIG from its environment, so a value from .env is passed on
    const result = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, MAILSTACK_CONFIG: env.MAILSTACK_CONFIG } });
    if (result.error || result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed.`);
  }, deployRelease = (proPath) => deploy({ cwd, proPath }), expected = extensionManifest } = {}) {
  const config = env.MAILSTACK_CONFIG?.trim(), proPath = env.MAILSTACK_PRO_PATH?.trim() || undefined;
  if (!config) throw new Error("MAILSTACK_CONFIG must name the external configuration.");
  const json = JSON.parse(readFileSync(config, "utf8"));
  if (((json.extensions ?? []).some((e) => e.module === "mailstack-pro") || json.clients) && !proPath) throw new Error("The configuration needs Mailstack Pro; set MAILSTACK_PRO_PATH.");
  guard(cwd, proPath);
  run("npm", ["run", "setup"]);
  const extension = await expected(json, proPath), manifest = migrationManifest(cwd, { pro: !!proPath, extension });
  log(`Migration manifest: ${manifest}`);
  run("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--remote"]);
  if (migrationManifest(cwd, { pro: !!proPath, extension }) !== manifest) throw new Error("Migrations changed after they were applied; deploy refused.");
  await deployRelease(proPath);
}

if (import.meta.main) await release().catch((error) => { console.error(`[release] ${error.message}`); process.exitCode = 1; });
