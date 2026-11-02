import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { readConfigFile } from "../src/core/config/node.ts";
import { loadConfig } from "../src/core/config/load.ts";
import { requireKeyProvider } from "../src/clients.ts";
import { loadEnv } from "./env.ts";

try {
  const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
  const mode = process.argv[2];
  const path = mode === "--example" ? resolve(root, "config/mailstack.example.json") : process.env.MAILSTACK_CONFIG;
  if (!path) throw new Error("$: MAILSTACK_CONFIG is required");
  const location = relative(root, realpathSync(path));
  if (mode !== "--example" && !location.startsWith("../") && !isAbsolute(location))
    throw new Error("$: MAILSTACK_CONFIG must be outside the repository");
  const json = readConfigFile(path);
  // Optional Mailstack Pro checkout (MAILSTACK_PRO_PATH): scoped keys; otherwise only the full key.
  const proPath = mode === "--example" ? undefined : loadEnv(root).MAILSTACK_PRO_PATH?.trim() || undefined;
  if (proPath && !isAbsolute(proPath)) throw new Error("$: MAILSTACK_PRO_PATH must be absolute");
  const worker = proPath && resolve(realpathSync(proPath), "src/worker.ts");
  if (worker) (await import(worker)).checkConfig(loadConfig(json));
  else requireKeyProvider(loadConfig(json));
  const sha = createHash("sha256").update(json).digest("hex");
  const outputs: [string, string][] = [
    ["src/core/config/bundled.ts", `export const CONFIG_JSON = ${JSON.stringify(json)};\nexport const BUILD_CONFIG_SHA = "${sha}";\n`],
    ["src/core/pro.generated.ts", worker ? `export { workerKeys as proKeys, CACHE_SCHEMA as proSchema } from ${JSON.stringify(worker)};\n`
      : `export const proKeys: import("../clients.ts").ProKeys | undefined = undefined;\nexport const proSchema: string | undefined = undefined;\n`],
  ];
  for (const [file, content] of outputs) {
    const output = resolve(root, file);
    if (mode === "--verify") {
      if (readFileSync(output, "utf8") !== content) throw new Error(`$: ${file} changed; run npm run setup`);
    } else if (mode !== "--check") writeFileSync(output, content);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "$: configuration build failed");
  process.exitCode = 1;
}
