import { afterEach, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import example from "../config/mailstack.example.json";

afterEach(() => { vi.doUnmock("../src/templates/config.ts"); vi.resetModules(); });
it("validates configuration before emitting a Worker bundle", () => {
  const dir = mkdtempSync(join(tmpdir(), "mailstack-boot-")), file = join(dir, "invalid.json");
  try {
    writeFileSync(file, '{"version":2}');
    const before = readFileSync("src/core/config/bundled.ts", "utf8");
    const result = spawnSync(process.execPath, ["scripts/bundle-config.ts", "--check"], { env: { ...process.env, MAILSTACK_CONFIG: file }, encoding: "utf8" });
    expect(result.status).toBe(1); expect(result.stderr).toContain("$.version");
    expect(readFileSync("src/core/config/bundled.ts", "utf8")).toBe(before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("starts the actual Node bundle with one compilation and rejects invalid startup input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mailstack-node-boot-")), file = join(dir, "config.json"), output = join(dir, "boot.mjs");
  try {
    await build({ stdin: { contents: 'import { config, compiledTemplates } from "./src/core/config/index.ts"; console.log(JSON.stringify({brands:Object.keys(config.brands),plans:compiledTemplates}));', resolveDir: process.cwd() },
      outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", plugins: [{ name: "boot-count", setup(builder) {
        builder.onResolve({ filter: /\/bundled\.ts$/ }, () => ({ path: resolve("src/runtime/config.ts") }));
        builder.onLoad({ filter: /\/templates\/config\.ts$/ }, async args => ({ contents: readFileSync(args.path, "utf8").replace("const plans: TemplatePlans =", 'console.error("compiled"); const plans: TemplatePlans ='), loader: "ts" }));
      } }] });
    // Resolve external runtime dependencies from the same installation as the application.
    const localOutput = resolve("node_modules/.cache/mailstack-boot-" + dir.split("-").at(-1) + ".mjs");
    const { mkdirSync, copyFileSync } = await import("node:fs"); mkdirSync(resolve("node_modules/.cache"), { recursive: true }); copyFileSync(output, localOutput);
    try {
      const run = () => spawnSync(process.execPath, [localOutput], { env: { ...process.env, MAILSTACK_CONFIG: file }, encoding: "utf8" });
      writeFileSync(file, JSON.stringify(example));
      const valid = run(); expect(valid.status).toBe(0); expect(valid.stderr.match(/^compiled$/gm)).toHaveLength(1);
      const { loadConfig } = await import("../src/core/config/load.ts"), { templatePlans } = await import("../src/templates/config.ts");
      expect(JSON.parse(valid.stdout).plans).toEqual(templatePlans(loadConfig(JSON.stringify(example))));
      writeFileSync(file, '{"version":2}');
      const invalid = run(); expect(invalid.status).not.toBe(0); expect(invalid.stderr).toContain("$.version"); expect(invalid.stdout).toBe("");
    } finally { rmSync(localOutput, { force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("imports the Worker artifact without recompiling configuration", async () => {
  vi.doMock("../src/templates/config.ts", async original => ({ ...await original<object>(), compileTemplatePlans: () => { throw new Error("unexpected compilation"); } }));
  await expect(import("../src/core/config/index.ts")).resolves.toHaveProperty("config.version", 1);
});
