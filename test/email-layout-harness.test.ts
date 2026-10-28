import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, Script } from "node:vm";
import { expect, it } from "vitest";
import { layoutCases } from "./email-layout-fixture";

it("initializes the generated measurement harness with complete case values", () => {
  const destination = mkdtempSync(join(tmpdir(), "email-layout-"));
  try {
    execFileSync(process.execPath, ["test/generate-email-layout-fixtures.ts", destination]);
    const html = readFileSync(join(destination, "index.html"), "utf8");
    const source = html.match(/<script>([\s\S]*?)<\/script\s*>/i)![1];
    const script = new Script(source);
    const root = { clientWidth: 374, scrollWidth: 374 };
    const body = { textContent: "", scrollWidth: 374 };
    const frame = { src: "", clientWidth: 374, contentDocument: {
      documentElement: root, body, querySelectorAll: () => [],
    } };
    const select = { value: layoutCases[0].id, onchange: () => {} };
    const button = { onclick: () => ({ missing: [] as string[], ok: false }) };
    const results = { textContent: "" };
    const window = { measureEmail: button.onclick };
    const elements = { "#email": frame, "#cases": select, "#measure": button, "#results": results };
    const context = createContext({ window, innerWidth: 390, innerHeight: 844,
      devicePixelRatio: 1, visualViewport: { scale: 1 },
      document: { querySelector: (selector: keyof typeof elements) => elements[selector] },
    });
    script.runInContext(context);

    expect(frame.src).toBe(`${layoutCases[0].id}.html`);
    expect(button.onclick).toBe(window.measureEmail);
    expect(JSON.parse(new Script("JSON.stringify(cases)").runInContext(context))).toEqual(layoutCases);
    expect(JSON.parse(readFileSync(join(destination, "cases.json"), "utf8"))).toEqual(layoutCases);
    for (const entry of layoutCases) {
      select.value = entry.id;
      select.onchange();
      expect(frame.src).toBe(`${entry.id}.html`);
      body.textContent = entry.values.join("\n");
      expect(button.onclick()).toMatchObject({ id: entry.id, missing: [], ok: true });
    }
    body.textContent = "";
    expect(window.measureEmail()).toMatchObject({ missing: layoutCases.at(-1)!.values, ok: false });
    expect(JSON.parse(results.textContent)).toHaveLength(layoutCases.length + 1);
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});
