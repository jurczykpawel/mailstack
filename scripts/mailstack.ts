import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readConfigFile } from "../src/core/config/node.ts";
import { parseConfig } from "../src/core/config/schema.ts";

try {
  const [command, action, file, ...extra] = process.argv.slice(2);
  if (command !== "config" || !file || extra.length || !["check", "import-brands"].includes(action))
    throw new Error("Usage: mailstack config check <file> | config import-brands <brands.ts>");
  if (action === "check") {
    let value: unknown;
    try { value = JSON.parse(readConfigFile(file)); } catch { throw new Error("$: invalid JSON or unreadable file"); }
    parseConfig(value);
    console.log("Configuration OK");
  } else {
    const { BRANDS } = await import(pathToFileURL(resolve(file)).href);
    const defaults = JSON.parse(readConfigFile(new URL("../config/mailstack.example.json", import.meta.url).pathname));
    console.log(JSON.stringify(parseConfig({ ...defaults, brands: BRANDS }), null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "$: configuration failed");
  process.exitCode = 1;
}
