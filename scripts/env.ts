import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** process.env plus the gitignored .env (simple KEY=VALUE lines; process.env wins). */
export function loadEnv(root: string): Record<string, string | undefined> {
  const env = { ...process.env };
  const file = resolve(root, ".env");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}
