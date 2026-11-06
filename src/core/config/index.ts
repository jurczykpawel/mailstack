import { VALIDATED_CONFIG, TEMPLATE_PLANS } from "./bundled.ts";
import type { Config } from "./schema.ts";
import { freezePlans, type TemplatePlans } from "../../templates/config.ts";
import type { Brand } from "../../types";

export const config: Config = VALIDATED_CONFIG as Config;
export const compiledTemplates: TemplatePlans = freezePlans(TEMPLATE_PLANS as TemplatePlans);
export { BUILD_CONFIG_SHA } from "./bundled.ts";
export function getBrand(id: string): Brand | undefined {
  return Object.hasOwn(config.brands, id) ? config.brands[id] : undefined;
}
export function findBrandByOrigin(origin: string): Brand | undefined {
  return origin ? Object.values(config.brands).find((brand) => brand.allowedOrigins.includes(origin)) : undefined;
}
