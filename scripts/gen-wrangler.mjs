#!/usr/bin/env node
/**
 * gen-wrangler.mjs — generate wrangler.toml from wrangler.template.toml + env vars.
 *
 * Reads deployment config from the environment (and a gitignored .env if present),
 * so real D1 ids / custom domain never live in the committed template. Missing vars
 * fall back to harmless placeholders, so `typecheck`/`test`/`dev` still work without
 * an .env — only a real `deploy` needs the real values.
 *
 * Vars: MAILSTACK_D1_ID, MAILSTACK_D1_PREVIEW_ID, MAILSTACK_ROUTE (optional).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { INITIAL_SCHEMA } from "../src/core/store/migration.ts";
import { BUILD_CONFIG_SHA } from "../src/core/config/bundled.ts";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };

// Load .env (simple KEY=VALUE parser; process.env wins).
const envFile = resolve(root, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const d1Id = env.MAILSTACK_D1_ID || "PLACEHOLDER_D1_ID";
const d1Preview = env.MAILSTACK_D1_PREVIEW_ID || "PLACEHOLDER_D1_PREVIEW_ID";
const route = (env.MAILSTACK_ROUTE || "").trim();
const sellfBrand = (env.SELLF_DEFAULT_BRAND || "acme").trim();

const routesBlock = route
  ? `routes = [\n  { pattern = "${route}", custom_domain = true },\n]`
  : "# No custom domain set (MAILSTACK_ROUTE empty) — using the default *.workers.dev URL.";

const out = readFileSync(resolve(root, "wrangler.template.toml"), "utf8")
  .replace("__ROUTES__", routesBlock)
  .replace("${SES_CONFIGURATION_SET}", JSON.stringify(env.SES_CONFIGURATION_SET || ""))
  .replace("${BUILD_CONFIG_SHA}", BUILD_CONFIG_SHA)
  .replaceAll("${MAILSTACK_D1_ID}", d1Id)
  .replaceAll("${MAILSTACK_D1_PREVIEW_ID}", d1Preview)
  .replaceAll("${SELLF_DEFAULT_BRAND}", sellfBrand);

mkdirSync(resolve(root, ".wrangler/migrations"), { recursive: true });
writeFileSync(resolve(root, ".wrangler/migrations/0001_initial.sql"), INITIAL_SCHEMA);
writeFileSync(resolve(root, "wrangler.toml"), out);

const placeholder = d1Id.startsWith("PLACEHOLDER");
console.log(
  `[gen-wrangler] wrote wrangler.toml (d1=${placeholder ? "PLACEHOLDER — set MAILSTACK_D1_ID in .env before deploy" : "from env"}, route=${route || "none (workers.dev)"})`,
);
