import { CONFIG_JSON } from "./bundled.ts";
import { loadConfig } from "./load.ts";
import type { Brand } from "../../types";

export const config = loadConfig(CONFIG_JSON);
export { BUILD_CONFIG_SHA } from "./bundled.ts";
export function getBrand(id: string): Brand | undefined {
  return Object.hasOwn(config.brands, id) ? config.brands[id] : undefined;
}
export function findBrandByOrigin(origin: string): Brand | undefined {
  return origin ? Object.values(config.brands).find((brand) => brand.allowedOrigins.includes(origin)) : undefined;
}
