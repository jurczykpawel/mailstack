#!/usr/bin/env node
/**
 * gen-wrangler.mjs — generate wrangler.toml from wrangler.template.toml + env vars.
 *
 * Reads deployment config from the environment (and a gitignored .env if present),
 * so real D1 ids / custom domain never live in the committed template. Missing vars
 * fall back to harmless placeholders, so `typecheck`/`test`/`dev` still work without
 * an .env — only a real `deploy` needs the real values.
 *
 * Vars: MAILSTACK_WORKER_NAME (Worker and database name, default mailstack), SES_REGION (default eu-west-1), MAILSTACK_D1_ID, MAILSTACK_D1_PREVIEW_ID, MAILSTACK_ROUTE and MAILSTACK_INTERNAL_ROUTE (optional);
 * MAILSTACK_PANEL_AUDIENCE (profile a: panel Worker through a service binding, no internal route);
 * the internal route needs MAILSTACK_ACCESS_TEAM_DOMAIN and MAILSTACK_ACCESS_AUD; MAILSTACK_EGRESS_URL is the https origin of the egress service (Pro webhooks, resend callbacks).
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { EVENTS_SCHEMA, EXT_SCHEMA, INITIAL_SCHEMA, JOBS_SCHEMA, PARTIAL_INDEX_SCHEMA, READ_SCHEMA, SES_STATUS_SCHEMA, WITHOUT_ROWID_SCHEMA } from "../src/core/store/migration.ts";
import { compileMigrations, migrationFile } from "../src/core/ext-migrations.ts";
import { BUILD_CONFIG_SHA, CONFIG_JSON } from "../src/core/config/bundled.ts";
import { proMigrations, proSchema } from "../src/core/pro.generated.ts";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = loadEnv(root);

const d1Id = env.MAILSTACK_D1_ID || "PLACEHOLDER_D1_ID";
const d1Preview = env.MAILSTACK_D1_PREVIEW_ID || "PLACEHOLDER_D1_PREVIEW_ID";
const route = (env.MAILSTACK_ROUTE || "").trim();
const workerName = (env.MAILSTACK_WORKER_NAME || "mailstack").trim();
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerName)) throw new Error("MAILSTACK_WORKER_NAME must be 1-63 lowercase letters, digits or hyphens");
const sesRegion = (env.SES_REGION || "eu-west-1").trim();
if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(sesRegion)) throw new Error("SES_REGION must be an AWS region such as eu-west-1");
const sellfBrand = (env.SELLF_DEFAULT_BRAND || "acme").trim();

const internal = (env.MAILSTACK_INTERNAL_ROUTE || "").trim();
if (internal && !route) throw new Error("MAILSTACK_INTERNAL_ROUTE requires MAILSTACK_ROUTE");
const team = (env.MAILSTACK_ACCESS_TEAM_DOMAIN || "").trim(), aud = (env.MAILSTACK_ACCESS_AUD || "").trim();
if (internal && !(team && aud)) throw new Error("MAILSTACK_INTERNAL_ROUTE requires MAILSTACK_ACCESS_TEAM_DOMAIN and MAILSTACK_ACCESS_AUD");
if (team && !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team)) throw new Error("MAILSTACK_ACCESS_TEAM_DOMAIN must be <team>.cloudflareaccess.com");
const panelAudience = (env.MAILSTACK_PANEL_AUDIENCE || "").trim();
if (panelAudience && !/^[A-Za-z0-9.:_-]{1,253}$/.test(panelAudience)) throw new Error("MAILSTACK_PANEL_AUDIENCE must be 1-253 characters of A-Z a-z 0-9 . : _ -");
// The internal host replaces PANEL_AUDIENCE as the audience (core transitAudience): an emergency route in profile (a) must not lock out the panel Worker.
if (panelAudience && internal && panelAudience !== internal) throw new Error("MAILSTACK_PANEL_AUDIENCE must equal MAILSTACK_INTERNAL_ROUTE when both are set");
const egress = (env.MAILSTACK_EGRESS_URL || "").trim();
if (egress && !/^https:\/\/[a-z0-9.-]+$/i.test(egress)) throw new Error("MAILSTACK_EGRESS_URL must be an https origin (https://host)");
// With a custom domain the workers.dev and preview URLs stay off, so only the listed hosts reach the Worker.
const routesBlock = route
  ? `workers_dev = false\npreview_urls = false\nroutes = [\n${[route, internal].filter(Boolean).map((pattern) => `  { pattern = "${pattern}", custom_domain = true },\n`).join("")}]`
  : "# No custom domain set (MAILSTACK_ROUTE empty) — using the default *.workers.dev URL.";

const out = readFileSync(resolve(root, "wrangler.template.toml"), "utf8")
  .replace("__ROUTES__", routesBlock + (proSchema ? `\n\n# Mailstack Pro resolves the core and zod from this checkout.\n[alias]\nmailstack = ${JSON.stringify(root)}\nzod = ${JSON.stringify(resolve(root, "node_modules/zod"))}` : ""))
  .replace("${SES_CONFIGURATION_SET}", JSON.stringify(env.SES_CONFIGURATION_SET || ""))
  .replace("${BUILD_CONFIG_SHA}", BUILD_CONFIG_SHA)
  .replaceAll("${MAILSTACK_WORKER_NAME}", workerName)
  .replace("${SES_REGION}", JSON.stringify(sesRegion))
  .replaceAll("${MAILSTACK_D1_ID}", d1Id)
  .replaceAll("${MAILSTACK_D1_PREVIEW_ID}", d1Preview)
  .replaceAll("${SELLF_DEFAULT_BRAND}", sellfBrand)
  .replace("${INTERNAL_HOST}", JSON.stringify(internal))
  .replace("${PANEL_AUDIENCE}", JSON.stringify(panelAudience))
  .replace("${ACCESS_TEAM_DOMAIN}", JSON.stringify(team))
  .replace("${ACCESS_AUD}", JSON.stringify(aud))
  .replace("${EGRESS_URL}", JSON.stringify(egress));

mkdirSync(resolve(root, ".wrangler/migrations"), { recursive: true });
writeFileSync(resolve(root, ".wrangler/migrations/0001_initial.sql"), INITIAL_SCHEMA);
writeFileSync(resolve(root, ".wrangler/migrations/0002_ses_status.sql"), SES_STATUS_SCHEMA);
writeFileSync(resolve(root, ".wrangler/migrations/0004_jobs.sql"), JOBS_SCHEMA);
writeFileSync(resolve(root, ".wrangler/migrations/0005_ext.sql"), EXT_SCHEMA);
writeFileSync(resolve(root, ".wrangler/migrations/0006_domain_events.sql"), EVENTS_SCHEMA);
writeFileSync(resolve(root, ".wrangler/migrations/0007_partial_indexes.sql"), PARTIAL_INDEX_SCHEMA);
writeFileSync(resolve(root, ".wrangler/migrations/0008_without_rowid.sql"), WITHOUT_ROWID_SCHEMA);
writeFileSync(resolve(root, ".wrangler/migrations/0009_read_schema.sql"), READ_SCHEMA);
// Extension migrations: validated and compiled from the schema builder; an invalid statement fails setup.
// Names are fixed per version (`<1000+version>_ext_<name>_<version>.sql`), so a regenerated file is never applied twice.
for (const file of readdirSync(resolve(root, ".wrangler/migrations"))) if (/^\d+_ext_.+\.sql$/.test(file)) rmSync(resolve(root, ".wrangler/migrations", file));
const entry = JSON.parse(CONFIG_JSON).extensions?.find((e) => e.module === "mailstack-pro");
// The runtime extension needs Worker bindings; setup reads its static schema for the same options.
const extension = entry && typeof proMigrations === "function" ? proMigrations(entry.options ?? {}) : undefined;
for (const m of extension ? await compileMigrations(extension.name, extension.migrations) : [])
  writeFileSync(resolve(root, ".wrangler/migrations", m.file), migrationFile(m));
const pro = resolve(root, ".wrangler/migrations/0003_pro_license_cache.sql");
if (proSchema) writeFileSync(pro, proSchema); else rmSync(pro, { force: true });
writeFileSync(resolve(root, "wrangler.toml"), out);

const placeholder = d1Id.startsWith("PLACEHOLDER");
console.log(
  `[gen-wrangler] wrote wrangler.toml (d1=${placeholder ? "PLACEHOLDER — set MAILSTACK_D1_ID in .env before deploy" : "from env"}, route=${route || "none (workers.dev)"})`,
);
