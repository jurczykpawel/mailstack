import { describe, it, expect } from "vitest";
import { getTemplate, renderLayout } from "../src/templates/index";
import { getBrand } from "../src/core/config";
const brand = { ...getBrand("acme")!, id: "selfware", name: "Selfware", subjectPrefix: "Nowe zlecenie" };
describe("Selfware templates", () => {
  it("confirms a task with the promised diagnosis deadline", () => {
    const body = getTemplate("received")!.render(brand, {});
    expect(body.bodyText).toContain("Dostaliśmy opis Twojego zadania");
    expect(body.bodyText).toContain("darmową diagnozą do 3 dni roboczych");
    expect(body.bodyText).not.toContain(":");
  });
  it("includes and escapes the film product in HTML and keeps plain text", () => {
    const body = getTemplate("received")!.render(brand, { name: "<Jan>", summary: "<Sellf>" });
    expect(body.bodyHtml).toContain("&lt;Sellf&gt;");
    expect(body.bodyHtml).toContain("&lt;Jan&gt;");
    expect(body.bodyText).toContain("<Sellf>");
    expect(body.bodyText).not.toContain("3 dni");
    expect(renderLayout(brand, body).text).toContain("Selfware");
  });
  it("preserves all submitted fields and metadata in the notification", () => {
    const template = getTemplate("contact")!;
    const data = { type: "Sellf", email: "test@example.com", message: "<opis>", custom: "inne", _origin: "https://example.com" };
    const body = template.render(brand, data);
    expect(template.subject(brand, data)).toBe("Nowe zlecenie — Sellf — Selfware");
    for (const value of Object.values(data)) expect(body.bodyText).toContain(value);
    expect(body.bodyHtml).toContain("&lt;opis&gt;");
    expect(body.bodyHtml).not.toContain("<opis>");
  });
  it("keeps other brands on the existing templates", () => {
    const other = getBrand("acme")!;
    expect(getTemplate("received")!.subject(other, {})).toBe("Potwierdzenie: otrzymaliśmy Twoje zgłoszenie");
    expect(getTemplate("received")!.render(other, {}).bodyText).toContain("odezwiemy się wkrótce");
    expect(getTemplate("contact")!.render(other, { message: "hello" }).bodyText).toContain("Wiadomość:");
  });
});
