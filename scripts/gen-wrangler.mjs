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
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { INITIAL_SCHEMA, SES_STATUS_SCHEMA } from "../src/core/store/migration.ts";
import { BUILD_CONFIG_SHA } from "../src/core/config/bundled.ts";
import { proSchema } from "../src/core/pro.generated.ts";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = loadEnv(root);

const d1Id = env.MAILSTACK_D1_ID || "PLACEHOLDER_D1_ID";
const d1Preview = env.MAILSTACK_D1_PREVIEW_ID || "PLACEHOLDER_D1_PREVIEW_ID";
const route = (env.MAILSTACK_ROUTE || "").trim();
const sellfBrand = (env.SELLF_DEFAULT_BRAND || "acme").trim();

const routesBlock = route
  ? `routes = [\n  { pattern = "${route}", custom_domain = true },\n]`
  : "# No custom domain set (MAILSTACK_ROUTE empty) — using the default *.workers.dev URL.";

const out = readFileSync(resolve(root, "wrangler.template.toml"), "utf8")
  .replace("__ROUTES__", routesBlock + (proSchema ? `\n\n# Mailstack Pro resolves the core and zod from this checkout.\n[alias]\nmailstack = ${JSON.stringify(root)}\nzod = ${JSON.stringify(resolve(root, "node_modules/zod"))}` : ""))
  .replace("${SES_CONFIGURATION_SET}", JSON.stringify(env.SES_CONFIGURATION_SET || ""))
  .replace("${BUILD_CONFIG_SHA}", BUILD_CONFIG_SHA)
  .replaceAll("${MAILSTACK_D1_ID}", d1Id)
  .replaceAll("${MAILSTACK_D1_PREVIEW_ID}", d1Preview)
  .replaceAll("${SELLF_DEFAULT_BRAND}", sellfBrand);

mkdirSync(resolve(root, ".wrangler/migrations"), { recursive: true });
writeFileSync(resolve(root, ".wrangler/migrations/0001_initial.sql"), INITIAL_SCHEMA);
writeFileSync(resolve(root, ".wrangler/migrations/0002_ses_status.sql"), SES_STATUS_SCHEMA);
const pro = resolve(root, ".wrangler/migrations/0003_pro_license_cache.sql");
if (proSchema) writeFileSync(pro, proSchema); else rmSync(pro, { force: true });
writeFileSync(resolve(root, "wrangler.toml"), out);

const placeholder = d1Id.startsWith("PLACEHOLDER");
console.log(
  `[gen-wrangler] wrote wrangler.toml (d1=${placeholder ? "PLACEHOLDER — set MAILSTACK_D1_ID in .env before deploy" : "from env"}, route=${route || "none (workers.dev)"})`,
);
