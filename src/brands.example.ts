import type { Brand } from "./types";

/**
 * DEMO brand registry. `npm run setup` copies this to `src/brands.ts` (which is
 * gitignored) on a fresh clone. Edit `src/brands.ts` with your real brands —
 * never commit it.
 *
 * Each entry is a tenant whose recipient (`to`) is fixed server-side and can
 * never be overridden by a public request (the core anti-relay rule). To add a
 * brand, append an entry keyed by a short slug and redeploy.
 */
export const BRANDS: Record<string, Brand> = {
  acme: {
    id: "acme",
    name: "Acme Inc.",
    // A verified SES sender for this brand's domain.
    from: "Acme Inc. <hello@acme.example>",
    // Fixed recipient(s) — public requests can never change this.
    to: ["inbox@acme.example"],
    allowedOrigins: [
      "https://acme.example",
      "https://www.acme.example",
      "http://localhost:4321",
      "http://localhost:4322",
      "http://localhost:4323",
    ],
    subjectPrefix: "New message from",
    // Send a confirmation back to the person who submitted the contact form.
    autoReply: true,
    theme: {
      accent: "#0064BC",
      accent2: "#A8D603",
      // Served by this Worker at GET /brand/logo.png (see src/assets/logo.ts).
      logoUrl: "https://mail.example.com/brand/logo.png",
      siteUrl: "https://acme.example",
      address: "123 Example Street, 00-000 Example City",
      phone: "+00 000 000 000",
    },
  },
  demo: {
    id: "demo",
    name: "Demo Brand",
    from: "Demo Brand <noreply@demo.example>",
    to: ["team@demo.example"],
    allowedOrigins: ["https://demo.example", "http://localhost:4321"],
    subjectPrefix: "New message",
    theme: {
      accent: "#008AFF",
      accent2: "#A8D603",
      siteUrl: "https://demo.example",
    },
  },
};
