#!/usr/bin/env node
/**
 * ensure-config.mjs — copy example config files to their real locations
 * if the real file does not yet exist. Safe to re-run; never overwrites.
 *
 * Run directly:  node scripts/ensure-config.mjs
 * Called by:    npm run setup  (and as a pre-hook for dev/test/typecheck/deploy)
 */

import { copyFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// Only business-specific config is gitignored + bootstrapped here. wrangler.toml is
// committed (it holds no secrets — just KV ids + your domain).
const pairs = [
  { src: "src/brands.example.ts", dst: "src/brands.ts" },
  { src: "src/assets/logo.example.ts", dst: "src/assets/logo.ts" },
];

let created = 0;
for (const { src, dst } of pairs) {
  const srcPath = resolve(root, src);
  const dstPath = resolve(root, dst);
  if (!existsSync(dstPath)) {
    copyFileSync(srcPath, dstPath);
    console.log(`[ensure-config] created ${dst} from ${src}`);
    created++;
  }
}

if (created === 0) {
  console.log("[ensure-config] all config files already present — nothing to do");
}
