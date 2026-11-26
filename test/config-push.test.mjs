import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { configPush } from "../scripts/config-push.mjs";
import { readConfigFile } from "../src/core/config/node.ts";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const example = readFileSync("config/mailstack.example.json", "utf8");
const edited = (change) => { const json = JSON.parse(example); change(json); return JSON.stringify(json, null, 2); };
const bundle = (json) => `export const CONFIG_JSON = ${JSON.stringify(json)};\nexport const BUILD_CONFIG_SHA = "${sha(json)}";\n`;
let cwd, file, calls, logs;
const bundled = () => join(cwd, "src/core/config/bundled.ts");
beforeEach(() => {
  cwd = mkdtempSync(resolve("node_modules/.config-push-")); calls = []; logs = [];
  mkdirSync(join(cwd, "src/core/config"), { recursive: true }); mkdirSync(join(cwd, ".wrangler/migrations"), { recursive: true });
  writeFileSync(join(cwd, ".wrangler/migrations/0001_initial.sql"), "-- core");
  writeFileSync(bundled(), bundle(example));
  file = join(cwd, "mailstack.json");
  writeFileSync(file, edited((json) => { json.brands.acme.subjectPrefix = "[Acme 2]"; }));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const STATUS = { versions: [{ version_id: "v2", percentage: 100 }] };
const LIST = [{ id: "v1", metadata: { created_on: "2026-11-01T00:00:00Z" } }, { id: "v2", metadata: { created_on: "2026-11-02T00:00:00Z" } }];
const go = (o = {}) => configPush({
  cwd, args: o.args ?? ["--yes"], log: (line) => logs.push(line),
  env: { MAILSTACK_CONFIG: file, MAILSTACK_HEALTH_URL: "https://mail.example.com/health", ...o.env },
  guard: () => ({ sha: "c1", pro: o.pro }),
  health: async () => o.health ?? { commit: "c1", ...o.pro ? { proCommit: o.pro } : {}, config: sha(example) },
  run: (cmd, args, env) => {
    calls.push([cmd, ...args].join(" "));
    if (args[1] === "setup") writeFileSync(bundled(), bundle(readFileSync(env.MAILSTACK_CONFIG, "utf8")));
    const migration = join(cwd, ".wrangler/migrations/1001_ext_pro_2.sql");
    if (args[1] === "setup" && o.schema) readFileSync(env.MAILSTACK_CONFIG, "utf8") === example ? rmSync(migration, { force: true }) : writeFileSync(migration, "-- new");
    if (args[1] === "setup" && o.restoreFails && (o.setups = (o.setups ?? 0) + 1) === 3) throw new Error("setup failed");
    if (cmd === "/hooks/copy.sh" && o.hookFails) throw new Error("hook failed");
  },
  wrangler: (args) => {
    calls.push(`wrangler ${args.join(" ")}`);
    if (args[0] === "rollback" && o.rollbackFails) throw new Error("wrangler rollback failed.");
    return args[0] === "deployments" ? JSON.stringify(o.status ?? STATUS) : args[0] === "versions" ? JSON.stringify(o.list ?? LIST) : "";
  },
  deployConfig: async ({ configSha, proPath }) => { calls.push(`deploy ${configSha === sha(readConfigFile(file)) ? "new" : configSha} ${proPath}`); if (o.fail) throw new Error("Health commit does not match HEAD."); },
  confirm: async () => { calls.push("confirm"); return o.answer ?? true; },
});

it("validates, lists changed renders and deploys the same code with the new configuration", async () => {
  await go({ args: [] });
  expect(calls).toEqual(["node scripts/bundle-config.ts --check", "wrangler deployments status --json", "wrangler versions list --json", "confirm", "npm run setup", "npm run setup", "deploy new undefined"]);
  expect(logs.join("\n")).toMatch(/acme\/contact\/default/);
  expect(logs.join("\n")).not.toMatch(/demo\//);
  expect(logs.join("\n")).toMatch(/brands\.acme\.subjectPrefix/);
});

it("does nothing when the file equals the deployed configuration", async () => {
  writeFileSync(file, example);
  await go();
  expect(calls).toEqual([]);
  expect(logs.join("\n")).toMatch(/No configuration change/);
});

it("N: refuses a checkout that differs from the deployed commit or Pro commit (a code release)", async () => {
  await expect(go({ health: { commit: "c0", config: sha(example) } })).rejects.toThrow(/code release/);
  await expect(go({ pro: "p1", health: { commit: "c1", proCommit: "p0", config: sha(example) } })).rejects.toThrow(/code release/);
  await expect(go({ health: { commit: "c1" } })).rejects.toThrow(/does not report its configuration/);
  expect(calls).toEqual([]);
});

it("N: needs a copy of the deployed configuration; --from supplies one, verified by its SHA-256", async () => {
  writeFileSync(bundled(), bundle("{}"));
  await expect(go()).rejects.toThrow(/--from/);
  const copy = join(cwd, "deployed.json"); writeFileSync(copy, "{}");
  await expect(go({ args: ["--yes", "--from", copy] })).rejects.toThrow(/--from/);
  writeFileSync(copy, example);
  await go({ args: ["--yes", "--from", copy] });
  expect(calls.at(-1)).toBe("deploy new undefined");
});

it("deploys a file change without render changes after listing the changed paths", async () => {
  writeFileSync(file, edited((json) => { json.brands.demo.allowedOrigins.push("https://other.example"); }));
  await go();
  expect(logs.join("\n")).toMatch(/Renders unchanged/);
  expect(logs.join("\n")).toMatch(/brands\.demo\.allowedOrigins\.2/);
  expect(calls.at(-1)).toBe("deploy new undefined");
});

it("N: stops without confirmation", async () => {
  await go({ args: [], answer: false });
  expect(calls).toEqual(["node scripts/bundle-config.ts --check", "wrangler deployments status --json", "wrangler versions list --json", "confirm"]);
});

it("N: refuses when the deployed version is not the newest and only one (no rollback behind a SES key rotation)", async () => {
  await expect(go({ status: { versions: [{ version_id: "v2", percentage: 50 }, { version_id: "v1", percentage: 50 }] } })).rejects.toThrow(/newest/);
  await expect(go({ list: [...LIST, { id: "v3", metadata: { created_on: "2026-11-03T00:00:00Z" } }] })).rejects.toThrow(/newest/);
  expect(calls.some((c) => c.startsWith("npm") || c.startsWith("deploy"))).toBe(false);
});

it("N: a configuration that changes the schema is refused and the previous setup restored", async () => {
  await expect(go({ schema: true })).rejects.toThrow(/npm run release/);
  expect(calls.filter((c) => c === "npm run setup")).toHaveLength(3);
  expect(calls.some((c) => c.startsWith("deploy"))).toBe(false);
  expect(readFileSync(bundled(), "utf8")).toBe(bundle(example));
});

it("rolls back to the replaced version and restores the setup when the deploy fails", async () => {
  await expect(go({ fail: true })).rejects.toThrow(/rolled back to v2/);
  expect(calls).toContain("wrangler rollback v2 --message config:push failed --yes");
  expect(readFileSync(bundled(), "utf8")).toBe(bundle(example));
});

it("runs the post-push hook with the configuration path; a hook failure only warns", async () => {
  await go({ env: { MAILSTACK_CONFIG_POST_PUSH: "/hooks/copy.sh" } });
  expect(calls.at(-1)).toBe(`/hooks/copy.sh ${file}`);
  writeFileSync(bundled(), bundle(example));
  await go({ env: { MAILSTACK_CONFIG_POST_PUSH: "/hooks/copy.sh" }, hookFails: true });
  expect(logs.join("\n")).toMatch(/hook failed/);
});

it("passes the Pro checkout on and requires MAILSTACK_HEALTH_URL", async () => {
  await go({ pro: "p1", env: { MAILSTACK_PRO_PATH: "/opt/pro" } });
  expect(calls.at(-1)).toBe("deploy new /opt/pro");
  await expect(go({ env: { MAILSTACK_HEALTH_URL: "" } })).rejects.toThrow(/MAILSTACK_HEALTH_URL/);
});

it("N: a failed rollback or restore says what state the Worker and the checkout are in", async () => {
  await expect(go({ fail: true, rollbackFails: true })).rejects.toThrow(/Rollback to v2 FAILED.*may serve the new configuration/);
  writeFileSync(bundled(), bundle(example));
  await expect(go({ fail: true, restoreFails: true })).rejects.toThrow(/rolled back to v2; restoring the setup failed/);
});

it("hashes template files inlined like setup, so configurations with file bodies can be pushed", async () => {
  writeFileSync(join(cwd, "promo.md"), "Hello **{name}**");
  writeFileSync(file, edited((json) => { json.mailTemplates = { version: 1, custom: { promo: { subject: "Promo", heading: "Promo", markdown: { file: "promo.md" } } } }; }));
  await go();
  expect(calls.at(-1)).toBe("deploy new undefined");
  expect(logs.join("\n")).toMatch(/acme\/promo\/default/);
});

it("N: rejects unknown arguments", async () => {
  for (const args of [["--ye"], ["--from=x"], ["--yes", "--from"]]) await expect(go({ args })).rejects.toThrow(/Usage/);
  expect(calls).toEqual([]);
});

it("notes source mapping changes, which renders do not cover", async () => {
  writeFileSync(file, edited((json) => { json.sources.sellf.signature.toleranceSeconds = 120; }));
  await go();
  expect(logs.join("\n")).toMatch(/Source mappings changed/);
});
