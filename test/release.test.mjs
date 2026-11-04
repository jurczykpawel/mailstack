import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { extensionManifest, release } from "../scripts/release.mjs";

let cwd, config, calls;
const PRO = ["0003_pro_license_cache.sql", "1001_ext_pro_1.sql"];
const CORE = ["0001_initial.sql", "0002_ses_status.sql", "0004_jobs.sql", "0005_ext.sql", "0006_domain_events.sql", "0007_partial_indexes.sql", "0008_without_rowid.sql"];
const migrations = () => join(cwd, ".wrangler/migrations");
beforeEach(() => {
  cwd = mkdtempSync(resolve("node_modules/.release-")); mkdirSync(migrations(), { recursive: true });
  config = join(cwd, "mailstack.json"); calls = [];
  writeFileSync(config, JSON.stringify({ version: 1, extensions: [{ module: "mailstack-pro" }] }));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

// Setup writes the external-config migrations; `between` runs after the remote apply, before the deploy.
const EXT = { [PRO[1]]: createHash("sha256").update(`-- ${PRO[1]}`).digest("hex") };
const go = ({ env = { MAILSTACK_CONFIG: config, MAILSTACK_PRO_PATH: "/opt/pro" }, files = [...CORE, ...PRO], between = () => {}, expected = EXT } = {}) => release({
  cwd, env, log: () => {}, expected: async () => expected,
  guard: (dir, pro) => calls.push(`guard ${pro}`),
  run: (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (args[1] === "setup") for (const f of files) writeFileSync(join(migrations(), f), `-- ${f}`);
    if (args.includes("apply")) between();
  },
  deployRelease: (pro) => calls.push(`deploy ${pro}`),
});

it("runs guard, setup, the remote migrations and the deploy of the same set, in that order", async () => {
  await go();
  expect(calls).toEqual(["guard /opt/pro", "npm run setup", "npx wrangler d1 migrations apply DB --remote", "deploy /opt/pro"]);
});

it("N: an example generator between the migrations and the deploy (Pro migrations removed) refuses the deploy", async () => {
  await expect(go({ between: () => { rmSync(join(migrations(), PRO[0])); rmSync(join(migrations(), PRO[1])); } }))
    .rejects.toThrow("Migration manifest is missing 0003_pro_license_cache.sql");
  expect(calls.some((c) => c.startsWith("deploy"))).toBe(false);
  // A changed file with the same name is caught too.
  calls = [];
  await expect(go({ between: () => writeFileSync(join(migrations(), "0006_domain_events.sql"), "-- other") })).rejects.toThrow("deploy refused");
  expect(calls.some((c) => c.startsWith("deploy"))).toBe(false);
});

it("N: setup without the Pro or extension migrations stops before any remote migration", async () => {
  for (const files of [[...CORE, PRO[1]], [...CORE, PRO[0]]]) {
    rmSync(migrations(), { recursive: true }); mkdirSync(migrations()); calls = [];
    await expect(go({ files })).rejects.toThrow("Migration manifest");
    expect(calls).toEqual(["guard /opt/pro", "npm run setup"]);
  }
});

it("N: refuses without the external configuration, or a Pro configuration without MAILSTACK_PRO_PATH", async () => {
  await expect(go({ env: {} })).rejects.toThrow("MAILSTACK_CONFIG");
  await expect(go({ env: { MAILSTACK_CONFIG: config } })).rejects.toThrow("set MAILSTACK_PRO_PATH");
  expect(calls).toEqual([]);
  // Without Pro, Pro migrations left over from another setup are refused.
  writeFileSync(config, JSON.stringify({ version: 1 }));
  await expect(go({ env: { MAILSTACK_CONFIG: config } })).rejects.toThrow("Pro migrations without MAILSTACK_PRO_PATH");
  rmSync(migrations(), { recursive: true }); mkdirSync(migrations()); calls = [];
  await go({ env: { MAILSTACK_CONFIG: config }, files: CORE, expected: {} });
  expect(calls).toEqual(["guard undefined", "npm run setup", "npx wrangler d1 migrations apply DB --remote", "deploy undefined"]);
});

it("accepts a Pro configuration whose compiled extension schema is empty, and only the compiled extension files", async () => {
  await go({ files: [...CORE, PRO[0]], expected: {} });
  expect(calls.at(-1)).toBe("deploy /opt/pro");
  // A leftover extension file, or a compiled file with other contents, is refused before any remote migration.
  for (const [files, expected] of [[[...CORE, ...PRO], {}], [[...CORE, ...PRO], { [PRO[1]]: "0".repeat(64) }]]) {
    rmSync(migrations(), { recursive: true }); mkdirSync(migrations()); calls = [];
    await expect(go({ files, expected })).rejects.toThrow("does not match the extension migrations");
    expect(calls).toEqual(["guard /opt/pro", "npm run setup"]);
  }
});

it("compiles no extension files without Mailstack Pro in the configuration", async () => {
  expect(await extensionManifest({ version: 1 })).toEqual({});
});
