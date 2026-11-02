import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { parseConfig } from "../src/core/config/schema";
import { renderEmail } from "../src/templates/index";

mkdirSync("priv", { recursive: true });
const dir = mkdtempSync("priv/config-test-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const cli = (args: string[], env = process.env) => spawnSync(process.execPath, ["scripts/mailstack.ts", ...args], { encoding: "utf8", env });
it("imports a typed legacy registry and prints only valid JSON", () => {
  const fixture = join(dir, "brands.ts");
  const example = JSON.parse(readFileSync("config/mailstack.example.json", "utf8"));
  writeFileSync(fixture, `import type { Brand } from "../../src/types"; export const BRANDS: Record<string, Brand> = ${JSON.stringify(example.brands)};`);
  const result = cli(["config", "import-brands", fixture]);
  expect(result.status, result.stderr).toBe(0);
  const file = join(dir, "mailstack.json"); writeFileSync(file, result.stdout);
  expect(JSON.parse(result.stdout).brands.acme.name).toBe("Acme Inc.");
  expect(cli(["config", "check", file]).status).toBe(0);
});
it.each(['quiet', 'console', 'stdout', 'deferred'])('imports a %s registry with JSON-only stdout and matching render', (mode) => {
  const example = JSON.parse(readFileSync('config/mailstack.example.json', 'utf8'));
  const diagnostics: Record<string, string> = {
    quiet: '',
    console: "console.log('synthetic diagnostic'); console.error('synthetic stderr');",
    stdout: "process.stdout.write('synthetic diagnostic\\n');",
    deferred: "setTimeout(() => process.stdout.write('synthetic diagnostic\\n'), 10);",
  };
  const fixture = join(dir, `brands-${mode}.ts`);
  writeFileSync(fixture, `${diagnostics[mode]} export const BRANDS = ${JSON.stringify(example.brands)};`);
  const result = cli(['config', 'import-brands', fixture]);
  expect(result.status, result.stderr).toBe(0);
  const imported = parseConfig(JSON.parse(result.stdout));
  const original = parseConfig(example);
  expect(imported.brands).toEqual(original.brands);
  const input = {
    subject: 'Synthetic subject', fields: [{ key: 'name', value: 'Jane' }], message: 'Synthetic message',
    meta: { receivedAt: '2026-03-01T00:00:00Z', origin: 'https://acme.example', ip: '192.0.2.1' },
  };
  expect(renderEmail(imported.brands.acme, input)).toEqual(renderEmail(original.brands.acme, input));
  if (mode === 'quiet') expect(result.stderr).toBe('');
  else expect(result.stderr).toContain('synthetic diagnostic');
});
it('reports a legacy module exception without partial JSON output', () => {
  const fixture = join(dir, 'brands-throws.ts');
  writeFileSync(fixture, "console.log('synthetic diagnostic'); throw new Error('synthetic import failure');");
  const result = cli(['config', 'import-brands', fixture]);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('synthetic diagnostic');
  expect(result.stderr).toContain('synthetic import failure');
});
it("reports invalid files and usage with a failing exit code", () => {
  const file = join(dir, "invalid.json"); writeFileSync(file, '{"version":2}');
  const result = cli(["config", "check", file]);
  expect(result.status).toBe(1); expect(result.stderr).toContain("$.version"); expect(result.stdout).toBe("");
  expect(cli(["config", "unknown"]).status).toBe(1);
  writeFileSync(file, "{"); expect(cli(["config", "check", file]).stderr).toContain("$: invalid JSON");
  expect(cli(["config", "check", join(dir, "absent.json")]).status).toBe(1);
});
it("loads Node config only from MAILSTACK_CONFIG and fails at startup", () => {
  const code = 'import { loadNodeConfig } from "./src/core/config/node.ts"; console.log(loadNodeConfig().version)';
  const run = (path: string) => spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: { ...process.env, MAILSTACK_CONFIG: path } });
  expect(run("config/mailstack.example.json").stdout.trim()).toBe("1");
  expect(run("").stderr).toContain("MAILSTACK_CONFIG");
  const file = join(dir, "bad-node.json"); writeFileSync(file, "{}");
  expect(run(file).status).toBe(1); expect(run(file).stderr).toContain("$.version");
});
it("requires an external path for Worker builds", () => {
  const run = (path: string) => spawnSync(process.execPath, ["scripts/bundle-config.ts", "--check"], { encoding: "utf8", env: { ...process.env, MAILSTACK_CONFIG: path } });
  expect(run("config/mailstack.example.json").stderr).toContain("outside the repository");
  expect(run("").stderr).toContain("MAILSTACK_CONFIG");
});
it("records the exact example bytes in the Worker bundle", async () => {
  const { createHash } = await import("node:crypto");
  const { CONFIG_JSON, BUILD_CONFIG_SHA } = await import("../src/core/config/bundled");
  expect(CONFIG_JSON).toBe(readFileSync("config/mailstack.example.json", "utf8"));
  expect(BUILD_CONFIG_SHA).toBe(createHash("sha256").update(CONFIG_JSON).digest("hex"));
  expect(readFileSync("wrangler.toml", "utf8").includes(`BUILD_CONFIG_SHA = "${BUILD_CONFIG_SHA}"`)).toBe(true);
});
it("builds external config and verifies subsequent input changes", async () => {
  const { cpSync, mkdirSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const root = join(dir, "build-root");
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "src/core/config"), { recursive: true });
  for (const file of ["schema.ts", "sources.ts", "load.ts", "node.ts"]) cpSync(`src/core/config/${file}`, join(root, "src/core/config", file));
  for (const file of ["bundle-config.ts", "env.ts"]) cpSync(`scripts/${file}`, join(root, "scripts", file));
  for (const file of ["urls.ts", "purchase-licenses.ts", "clients.ts"]) cpSync(`src/${file}`, join(root, "src", file));
  cpSync("src/templates", join(root, "src/templates"), { recursive: true });
  cpSync("src/markup", join(root, "src/markup"), { recursive: true });
  cpSync("docs/sources", join(root, "docs/sources"), { recursive: true });
  const file = join(dir, "external.json");
  const json = readFileSync("config/mailstack.example.json", "utf8"); writeFileSync(file, json);
  const run = (mode?: string) => spawnSync(process.execPath, [join(root, "scripts/bundle-config.ts"), ...(mode ? [mode] : [])], { encoding: "utf8", env: { ...process.env, MAILSTACK_CONFIG: file } });
  expect(run().status).toBe(0);
  expect(readFileSync(join(root, "src/core/config/bundled.ts"), "utf8")).toContain(createHash("sha256").update(json).digest("hex"));
  expect(run("--verify").status).toBe(0);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(json), clients: [] }));
  const scoped = run("--check");
  expect(scoped.status).toBe(1); expect(scoped.stderr).toContain("$.clients: additional or restricted API keys require Mailstack Pro");
  writeFileSync(file, json + "\n");
  expect(run("--verify").stderr).toContain("bundled.ts changed");
  writeFileSync(file, "{}");
  expect(run().stderr).toContain("$.version");
});

