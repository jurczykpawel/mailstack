import type { Config } from "../core/config/schema.ts";
import { freezePlans, mergeDefinitions, own, type TemplatePlans } from "./config.ts";
import { normalizeLocale } from "./language-tag.ts";
import { MANIFEST } from "./manifest.ts";
import { customPlan } from "./custom.ts";
export { normalizeLocale } from "./language-tag.ts";
const handles = new WeakMap<number[], { definition: ReturnType<typeof mergeDefinitions>; locale: string | null }>();
const neutral = freezePlans({ definition: {} as ReturnType<typeof mergeDefinitions>, locale: null });
export function resolvePresentation(plans: TemplatePlans, brand: Config["brands"][string], template: string, kind = "", input: unknown = null) {
  if (!Object.hasOwn(MANIFEST, template)) {
    const plan = customPlan(plans, brand.id, template), languages = brand.mailTemplates?.languages;
    if (!plan) throw new Error("unknown template combination");
    const preference = languages ? normalizeLocale(input) : null;
    const locale = languages ? [preference, preference?.split("-")[0]].find(tag => tag && languages.allowed.includes(tag) && own(plan.locales, tag)) ?? languages.default : null;
    return { definition: neutral.definition, locale };
  }
  const brandRoutes = own(plans.routes, brand.id);
  if (!brandRoutes && !brand.mailTemplates) return neutral;
  const routes = own(own(brandRoutes, template), kind);
  const languages = brand.mailTemplates?.languages;
  const preference = languages ? normalizeLocale(input) : null;
  const locale = languages ? [preference, preference?.split("-")[0], languages.default].find(tag => tag && own(routes, tag)) : "";
  const indices = typeof locale === "string" ? own(routes, locale) : undefined;
  if (!indices) throw new Error("unknown template combination");
  let handle = handles.get(indices);
  if (!handle) {
    handle = freezePlans({ definition: mergeDefinitions(indices.map(index => plans.fragments[index])), locale: locale || null });
    handles.set(indices, handle);
  }
  return handle;
}
