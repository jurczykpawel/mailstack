import { copyFileSync, existsSync } from "node:fs";

const target = new URL("../src/assets/logo.ts", import.meta.url);
if (!existsSync(target)) {
  copyFileSync(new URL("../src/assets/logo.example.ts", import.meta.url), target);
  console.log("[ensure-config] created src/assets/logo.ts");
}
