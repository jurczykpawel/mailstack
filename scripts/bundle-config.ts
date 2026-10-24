import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { readConfigFile } from "../src/core/config/node.ts";
import { loadConfig } from "../src/core/config/load.ts";

try {
  const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
  const mode = process.argv[2];
  const path = mode === "--example" ? resolve(root, "config/mailstack.example.json") : process.env.MAILSTACK_CONFIG;
  if (!path) throw new Error("$: MAILSTACK_CONFIG is required");
  const location = relative(root, realpathSync(path));
  if (mode !== "--example" && !location.startsWith("../") && !isAbsolute(location))
    throw new Error("$: MAILSTACK_CONFIG must be outside the repository");
  const json = readConfigFile(path);
  loadConfig(json);
  const sha = createHash("sha256").update(json).digest("hex");
  const output = resolve(root, "src/core/config/bundled.ts");
  const content = `export const CONFIG_JSON = ${JSON.stringify(json)};\nexport const BUILD_CONFIG_SHA = "${sha}";\n`;
  if (mode === "--verify") {
    if (readFileSync(output, "utf8") !== content) throw new Error("$: BUILD_CONFIG_SHA changed; run npm run setup");
  } else if (mode !== "--check") writeFileSync(output, content);
} catch (error) {
  console.error(error instanceof Error ? error.message : "$: configuration build failed");
  process.exitCode = 1;
}
