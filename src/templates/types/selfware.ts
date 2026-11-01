import type { Brand, RenderedBody, TemplateData } from "../../types.ts";
import { humanizeLabel, paragraph, summaryTable } from "../layout.ts";

export function selfwareReceived(data: TemplateData): RenderedBody {
  const summary = (data.summary || "").trim();
  const product = summary === "Opis zadania" ? "" : summary;
  const greeting = data.name?.trim() ? `Cześć ${data.name.trim()},` : "Cześć,";
  const intro = product
    ? `Dostaliśmy Twoje zapytanie o podobne rozwiązanie do ${product}. Odezwę się osobiście na podany adres e-mail.`
    : "Dostaliśmy opis Twojego zadania. Odezwiemy się z darmową diagnozą do 3 dni roboczych.";
  const closing = "Jeśli chcesz coś dopowiedzieć, odpowiedz na tego maila.\n\nSelfware";
  return {
    heading: product ? "Dostaliśmy Twoje zapytanie" : "Dostaliśmy opis Twojego zadania",
    previewText: intro,
    bodyHtml: [greeting, intro, closing].map(paragraph).join("\n"),
    bodyText: [greeting, intro, closing].join("\n\n"),
  };
}

export function selfwareContactSubject(brand: Brand, data: TemplateData): string {
  return `${brand.subjectPrefix}${data.type?.trim() ? ` — ${data.type.trim()}` : ""} — Selfware`;
}

export function selfwareContact(brand: Brand, data: TemplateData): RenderedBody {
  const intro = data.type?.trim() && data.type.trim() !== "Opis zadania"
    ? `Ktoś pyta o rozwiązanie podobne do ${data.type.trim()}. Odpowiedz na ten mail, aby skontaktować się z nadawcą.`
    : "Przyszedł opis zadania. Odpowiedz na ten mail, aby skontaktować się z nadawcą. Darmową diagnozę zapowiadamy do 3 dni roboczych.";
  const rows = Object.entries(data).filter(([, value]) => value.trim()).map(([key, value]) => ({
    label: ({ _receivedAt: "Otrzymano", _origin: "Źródło", _ip: "IP", type: "Produkt" } as Record<string, string>)[key] || humanizeLabel(key), value,
  }));
  return {
    heading: selfwareContactSubject(brand, data), previewText: intro,
    bodyHtml: paragraph(intro) + summaryTable(rows),
    bodyText: [intro, ...rows.map(({ label, value }) => `${label}\n${value}`)].join("\n\n"),
  };
}
