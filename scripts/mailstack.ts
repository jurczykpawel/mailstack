import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readConfigFile } from "../src/core/config/node.ts";
import { clientSchema, parseConfig } from "../src/core/config/schema.ts";
import { tokenSha256 } from "../src/clients.ts";

async function createClient(args: string[]) {
  const options = new Map<string, string>();
  const flags = new Set(["--id", "--scopes", "--brands", "--templates", "--recipient-override"]);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!flags.has(flag) || options.has(flag)) throw new Error("Invalid client option");
    const value = flag === "--recipient-override" ? "true" : args[++i];
    if (!value || value.startsWith("--")) throw new Error("Missing client option value");
    options.set(flag, value);
  }
  const requestedScopes = options.get("--scopes")?.split(",");
  if (requestedScopes?.some((scope) => scope === "send" || scope.startsWith("hook:"))) {
    for (const flag of ["--brands", "--templates"]) {
      if (!options.has(flag)) throw new Error(`${flag} is required for send or hook scope`);
    }
  }
  const token = `msk_${options.get("--id")}_${randomBytes(32).toString("base64url")}`;
  const list = (flag: string) => options.get(flag) === "*" ? "*" : options.get(flag)?.split(",");
  const result = clientSchema.safeParse({
    id: options.get("--id"), tokenSha256: await tokenSha256(token), scopes: list("--scopes"),
    brands: list("--brands"), templates: list("--templates"), recipientOverride: options.has("--recipient-override"),
  });
  if (!result.success) throw new Error("Invalid client configuration");
  console.log(JSON.stringify({ token, client: result.data }, null, 2));
}

try {
  const [command, action, file, ...extra] = process.argv.slice(2);
  if (command === "client" && action === "create") {
    await createClient(process.argv.slice(4));
  } else if (command === "log") {
    const { readLog } = await import("./log.ts");
    await readLog(process.argv.slice(3));
  } else {
    if (command !== "config" || !file || extra.length || !["check", "import-brands"].includes(action))
      throw new Error("Usage: mailstack config check <file> | config import-brands <brands.ts>");
    if (action === "check") {
      let value: unknown;
      try { value = JSON.parse(readConfigFile(file)); } catch { throw new Error("$: invalid JSON or unreadable file"); }
      parseConfig(value);
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
