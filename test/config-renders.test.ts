import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { changedPaths, changedRenders, renders } from "../scripts/config-renders.ts";

const example = readFileSync("config/mailstack.example.json", "utf8");
const edit = (change: (json: any) => void) => { const json = JSON.parse(example); change(json); return JSON.stringify(json); };

it("renders every brand and template, plus the auto-reply only for brands that enable it", () => {
  const keys = Object.keys(renders(example));
  for (const brand of ["acme", "demo"]) for (const t of ["contact", "welcome", "received", "payment", "license", "refund", "notice", "bank-transfer"])
    expect(keys).toContain(`${brand}/${t}/default`);
  expect(keys).toContain("acme/received/default/auto-reply");
  expect(keys).not.toContain("demo/received/default/auto-reply");
});

it("lists only the renders a template change affects, including the auto-reply and languages", () => {
  const next = edit((json) => {
    json.mailTemplates = { version: 1 };
    json.brands.acme.mailTemplates = { languages: { default: "pl", allowed: ["pl", "en"] },
      templates: { received: { locales: { en: { copy: { greetingWithoutName: "Hello there," } } } } } };
  });
  const changed = changedRenders(example, next);
  expect(changed).toContain("acme/received/en/auto-reply");
  expect(changed.every((key) => key.startsWith("acme/"))).toBe(true);
  expect(changedRenders(example, example)).toEqual([]);
});

it("reports changed configuration paths without values, also when no render changes", () => {
  const next = edit((json) => { json.brands.demo.allowedOrigins.push("https://other.example"); json.cloudflare = undefined; });
  expect(changedRenders(example, next)).toEqual([]);
  expect(changedPaths(example, next)).toEqual(["brands.demo.allowedOrigins.2", "cloudflare.plan"]);
});
