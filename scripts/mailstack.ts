import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readConfigFile } from "../src/core/config/node.ts";
import { templatePlans } from "../src/templates/config.ts";
import { parseConfig } from "../src/core/config/schema.ts";

try {
  const [command, action, file, ...extra] = process.argv.slice(2);
  if (command === "client") {
    throw new Error("Scoped API clients require Mailstack Pro: run `node scripts/client.ts create` in mailstack-pro");
  } else if (command === "log") {
    const { readLog } = await import("./log.ts");
    await readLog(process.argv.slice(3));
  } else {
    if (command !== "config" || !file || extra.length || !["check", "import-brands"].includes(action))
      throw new Error("Usage: mailstack config check <file> | config import-brands <brands.ts>");
    if (action === "check") {
      let value: unknown;
      try { value = JSON.parse(readConfigFile(file)); } catch { throw new Error("$: invalid JSON or unreadable file"); }
      const config = parseConfig(value);
      for (const warning of templatePlans(config).warnings) console.warn(warning);
      console.log("Configuration OK");
    } else {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { writeFileSync } from 'node:fs';
        try {
          const { BRANDS } = await import(process.argv[1]);
          writeFileSync(3, JSON.stringify(BRANDS));
        } catch (error) {
          console.error(error instanceof Error ? error.message : 'Legacy import failed');
          process.exitCode = 1;
        }
      `, pathToFileURL(resolve(file)).href], { encoding: "utf8", stdio: ["ignore", 2, 2, "pipe"] });
      if (result.error || result.status !== 0) throw new Error("Unable to import legacy registry");
      let BRANDS: unknown;
      try { BRANDS = JSON.parse(String(result.output[3])); }
      catch { throw new Error("Legacy registry must export JSON-compatible BRANDS"); }
      const defaults = JSON.parse(readConfigFile(new URL("../config/mailstack.example.json", import.meta.url).pathname));
      console.log(JSON.stringify(parseConfig({ ...defaults, brands: BRANDS }), null, 2));
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "$: configuration failed");
  process.exitCode = 1;
}
