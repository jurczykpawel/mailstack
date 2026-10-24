import { readFileSync } from "node:fs";
import { loadConfig } from "./load.ts";
import type { LoadOptions } from "./load.ts";

export function readConfigFile(path: string) {
  try { return readFileSync(path, "utf8"); } catch { throw new Error("$: cannot read MAILSTACK_CONFIG file"); }
}
export function loadNodeConfig(options: LoadOptions = {}) {
  const path = process.env.MAILSTACK_CONFIG;
  if (!path) throw new Error("$: MAILSTACK_CONFIG is required");
  return loadConfig(readConfigFile(path), options);
}
