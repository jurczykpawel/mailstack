# mailstack

A universal, secure **form-to-email + transactional email sender** running on a single
Cloudflare Worker. Self-owned alternative to Web3Forms: your forms POST here, the Worker
validates and renders a branded email, and sends it via **Amazon SES**. Multi-tenant by
design — each "brand" has its own sender, fixed recipient, origin allowlist, and theme.

Stack: Cloudflare Workers + TypeScript (strict), `aws4fetch` for SES SigV4, KV for rate
limiting. No database. Entry point `src/index.ts` (`export default { fetch }`).

## Public API

Base URL is wherever the Worker is deployed (e.g. `https://mail.example.com`).

### `GET /health`
Liveness check.
```json
{ "ok": true, "service": "mailstack" }
```

### `OPTIONS /v1/send`
CORS preflight. The brand is resolved from `?brand=<id>` if present, otherwise from the
first brand whose allowlist contains the `Origin`. If the origin is allowed → `204` with:
```
Access-Control-Allow-Origin: <origin>
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: content-type, authorization
Access-Control-Max-Age: 86400
```
Otherwise `403` (no CORS headers).

### `POST /v1/send`
Main handler. Always responds with JSON `{ success: boolean, message?: string }`. The
`Access-Control-Allow-Origin` header is echoed only when the origin is allowed for the brand.

Request body is **flat JSON**: a few control keys plus arbitrary content fields.

| Control key | Meaning |
|---|---|
| `brand` | **required** — brand id (`acme`, `demo`, ...) |
| `cf-turnstile-response` | Cloudflare Turnstile token (public mode) |
| `botcheck` | honeypot — must be empty/absent |
| `access_key` | reserved (prefer the bearer header for trusted mode) |
| `subject` | subject override (trusted mode only) |
| `to` | recipient override (trusted mode only, validated) |
| `replyTo` | Reply-To override (trusted mode only, validated) |
| `template` | email type to render (trusted mode only); public is always `contact` |
| `autoreply` | per-request toggle for the submitter confirmation (`1`/`true`/`yes`/`on` vs `0`/`false`); overrides `brand.autoReply`. See [Auto-reply](#auto-reply). |
| `_meta` | reserved, ignored as content |

Everything else (`name`, `email`, `phone`, `message`, `type`, `topic`, `person`, `gdpr`,
or any custom key) is treated as a **content field** and fed to the selected template.
See [Templates](#templates) for the per-type fields.

## Two modes

### Public mode (browser forms)
No bearer token (or an invalid one). The Worker enforces **all** of:
1. **Origin allowlist** — `Origin` must be in `brand.allowedOrigins`, else `403 origin not allowed`.
2. **Honeypot** — a non-empty `botcheck` returns `200 {success:true}` and sends nothing.
3. **Turnstile** — token verified server-side; failure → `403 verification failed`.
4. **Rate limit** — KV fixed window, 8 requests/hour per `brand`+IP, else `429`.
5. **Fixed recipient** — mail always goes to `brand.to`; any `to`/`from` in the body is ignored (anti-relay).

On success, a `contact` submission may also send a confirmation back to the submitter — see
[Auto-reply](#auto-reply).

```bash
curl -X POST https://mail.example.com/v1/send \
  -H 'content-type: application/json' \
  -H 'origin: https://acme.example' \
  -d '{
    "brand": "acme",
    "name": "Jane Smith",
    "email": "jane@example.com",
    "type": "Consultation",
    "message": "Please get in touch.",
    "cf-turnstile-response": "<token-from-widget>"
  }'
# -> { "success": true }
```

### Trusted mode (server-to-server / transactional)
Send `Authorization: Bearer <API_KEY>` matching the `API_KEY` secret (compared in
constant time). This **skips** Turnstile and origin checks, and allows:
- a `template` selection (any registered type — see [Templates](#templates); public is
  always pinned to `contact`),
- a `subject` override,
- a validated `to` override (valid email(s), capped to 5),
- a validated `replyTo` override.

Transactional example (payment receipt):

```bash
curl -X POST https://mail.example.com/v1/send \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $MAILSTACK_API_KEY" \
  -d '{
    "brand": "acme",
    "template": "payment",
    "to": "buyer@example.com",
    "name": "Jane Smith",
    "amount": "149.00",
    "currency": "USD",
    "item": "Pro Plan",
    "orderId": "ORD-7788",
    "date": "2026-06-10",
    "invoiceUrl": "https://example.com/fv/ORD-7788.pdf"
  }'
# -> { "success": true }   (subject: "Potwierdzenie płatności - ORD-7788")
```

Error responses:

| Status | Body | When |
|---|---|---|
| 400 | `unknown brand` / `invalid JSON` / `invalid recipient` / `unknown template` | bad input |
| 403 | `origin not allowed` / `verification failed` | public-mode gate failed |
| 413 | `payload too large` | body > 64 KB |
| 429 | `rate limit exceeded` | public-mode rate limit hit |
| 502 | `send failed` | SES returned a non-2xx response |

## Brands config

Brands live in `src/brands.ts`, keyed by short id:

```ts
interface Brand {
  id: string; name: string;
  from: string;            // verified SES sender, e.g. "Foo <info@foo.example>"
  to: string[];            // fixed recipient(s) — body can never change this
  allowedOrigins: string[];
  subjectPrefix: string;
  theme: { accent: string; accent2?: string; logoUrl?: string; siteUrl: string; address?: string; phone?: string; };
  autoReply?: boolean;         // default for the contact auto-reply (default false). See Auto-reply.
  autoReplyTemplate?: string;  // template used for the auto-reply (default "received")
}
```

Example brands (in `src/brands.example.ts`): `acme` (Acme Inc., `autoReply: true`) and `demo` (Demo Brand). Edit `src/brands.ts` (gitignored) to configure your own.

### How to add a brand
1. Append an entry to the `BRANDS` map in `src/brands.ts` with a new id.
2. Set `from` to a **verified SES sender** (domain/identity must be verified in the
   account region, `SES_REGION`).
3. Set `to` to the fixed inbox, list the site's `allowedOrigins`, and fill `theme`.
4. Add a test in `test/brands.test.ts` if you want, then `npm run typecheck && npm run test`.
5. Redeploy.

No code changes are needed elsewhere — `getBrand` / `findBrandByOrigin` read the map.

## Templates

mailstack can send different **kinds** of email, all sharing one per-brand look. The
chrome (header band with logo/accent + footer with address/phone/site) lives in a single
**layout** (`src/templates/layout.ts`); each **template type** only produces its own
content. The type is chosen by the `template` control key — **public requests are always
pinned to `contact`**; only trusted requests may pick another type.

Every value is HTML-escaped. Subjects/headings follow the existing brand conventions; new
copy uses hyphens and colons (no em-dashes). The `contact` template is unchanged from the
original form behavior.

| `template` | Purpose | Content fields (all optional unless noted) |
|---|---|---|
| `contact` *(public)* | Contact-form submission | any fields → rendered as a label/value table; `message` → its own block; `type` tweaks the subject. Reply-To = submitter `email`. |
| `welcome` | Onboarding / welcome | `name`, `intro`, `body`, `ctaUrl`, `ctaLabel` |
| `received` | "We got your message" ack | `name`, `refId`, `summary` |
| `payment` | Payment confirmation | `amount` (shown), `currency` (default `PLN`), `item`/`description`, `orderId`, `date`, `invoiceUrl` (→ "Pobierz fakturę" button), `name` |
| `notice` | Generic catch-all | `heading`, `paragraphs` (string or array of strings), `ctaUrl`, `ctaLabel`, `subject` (subject override) |

Notes:
- **Reply-To:** `contact` replies to the submitter's `email`; all other types reply to the
  brand inbox (`brand.to[0]`) so a recipient's reply reaches the brand. Trusted requests may
  override with `replyTo`.
- **Subject:** each type computes its own subject; a trusted `subject` override always wins.
- `notice.paragraphs` may be a JSON array (joined into blocks) or a string with blank-line
  separators.

### How to add a template type
1. Create `src/templates/types/<id>.ts` exporting a `TemplateDef` (`id`, optional
   `publicAllowed`, `subject(brand, data)`, `render(brand, data) => { heading, bodyHtml,
   bodyText, previewText? }`). Build HTML with the shared helpers from `../layout`
   (`escapeHtml`, `paragraph`, `summaryTable`, `ctaButton`/`ctaText`) so it stays on-brand —
   do **not** re-create the header/footer chrome.
2. Register it in the `TEMPLATES` map in `src/templates/index.ts`.
3. Leave `publicAllowed` falsy unless the type is safe for unauthenticated browser use
   (only `contact` is). The handler pins public requests to `contact` regardless.
4. Add a test in `test/template-types.test.ts`, then `npm run typecheck && npm run test`.

### Auto-reply

A public **contact** submission can optionally send a confirmation back to the person who
submitted (a "we received your message" email), in addition to the main email to
`brand.to`.

- **When it fires:** public mode + `contact` template + a syntactically valid submitter
  `email`, and only **after the main email was sent successfully**. Trusted/transactional
  sends never auto-reply.
- **Enable/disable:** per-request `autoreply` control key wins (`1`/`true`/`yes`/`on` =
  on, `0`/`false`/`no`/`off`/empty = off); otherwise the brand default `brand.autoReply`
  applies (default `false`). The demo `acme` brand defaults to **on**; `demo` is off.
- **What it sends:** the `received` template (override per brand with
  `brand.autoReplyTemplate`), themed for the brand, `from: brand.from`, `to:` the
  submitter, `replyTo: brand.to[0]` so their reply reaches the brand inbox. The
  confirmation carries the submitter's name and the `type`/`topic` as a short summary.
- **Non-blocking + best-effort:** dispatched via the Worker's `ctx.waitUntil`, so it never
  delays the response; if the auto-reply send fails it is swallowed (the submission already
  succeeded → the user still gets `{success:true}`). It is a single direct send and never
  triggers another auto-reply.

```bash
# Opt a single submission out of the brand's default auto-reply:
curl -X POST https://mail.example.com/v1/send \
  -H 'content-type: application/json' -H 'origin: https://acme.example' \
  -d '{ "brand":"acme", "email":"jane@example.com", "message":"...",
        "autoreply":"0", "cf-turnstile-response":"<token>" }'
```

## Sellf webhook (`/v1/hooks/sellf`)

`POST /v1/hooks/sellf` turns Sellf webhook events into branded emails to the customer,
reusing the existing templates (no new template types).

- **Auth: Bearer only — no HMAC.** Sellf calls us as a trusted client with
  `Authorization: Bearer <API_KEY>` (the same `API_KEY` secret, compared constant-time).
  Missing/invalid → `401 {success:false,message:"unauthorized"}`. Any `X-Sellf-*` headers
  are ignored.
- **Brand:** `?brand=<id>`, defaults to `SELLF_DEFAULT_BRAND` env var or the first brand in the registry. Unknown brand → `400 {success:false,message:"unknown brand"}`.
- **Body:** the Sellf envelope `{ event: string, timestamp: ISO string, data: object }`.
  Bad JSON → `400`.
- **Recipient:** the customer email from the payload (this endpoint may set `to`, like
  trusted mode); `from: brand.from`, `replyTo: brand.to[0]`.
- **Retries:** the SES send is **awaited** (not backgrounded). A failed send →
  `502 {success:false,message:"send failed"}` so Sellf retries; success → `200 {success:true}`.
  Unmapped events and missing/invalid recipients are **acked** (`200 {success:true, ignored:"..."}`)
  so Sellf does not retry something we will never email.

### Event → template mapping

Defined in `SELLF_EVENT_MAP` (`src/sellf.ts`). Payload paths mirror Sellf's contract exactly.

| Sellf event | Template | Key mapping |
|---|---|---|
| `purchase.completed` | `payment` | `to=data.customer.email`, `name=firstName+lastName`, `amount=money(order.amount)`, `currency=order.currency.toUpperCase()`, `item=product.name`, `orderId=order.sessionId ?? order.paymentIntentId`, `date=plDate(timestamp)` |
| `refund.issued` | `notice` | "Zwrot środków" — refunded `money(refund.amount)` `refund.currency` for `product.name`, plus the transaction id (`payment.sessionId ?? payment.paymentIntentId`) |
| `waitlist.signup` | `notice` | "Jesteś na liście oczekujących" — thanks for signing up to `product.name` |
| `lead.captured` | `welcome` | intro "Twój dostęp do `product.name` jest gotowy." (no CTA) |
| `access.expired` | `notice` | "Dostęp wygasł" — access to `product.name` expired, reply to renew |
| anything else (`subscription.*`, `invoice.*`, …) | — | not emailed → `200 {ignored:"<event>"}` |

Helpers: `money(cents) = (Number(cents)/100).toFixed(2)`; `plDate(iso) = new Date(iso).toLocaleDateString("pl-PL")` (invalid → `""`); currencies are upper-cased. HTML-escaping is handled by the templates.

### Add a new event mapping
Add an entry to `SELLF_EVENT_MAP` in `src/sellf.ts`: a function
`(envelope) => { template, to, data, subject? } | null` that picks an existing template id,
pulls `to` from the payload, and builds the template `data`. Add a case to
`test/sellf-hook.test.ts`, then `npm run typecheck && npm run test`. No other wiring needed.

### Example

```bash
curl -X POST "https://mail.example.com/v1/hooks/sellf?brand=acme" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $MAILSTACK_API_KEY" \
  -d '{
    "event": "purchase.completed",
    "timestamp": "2026-06-10T09:30:00.000Z",
    "data": {
      "customer": { "email": "buyer@example.com", "firstName": "Jane", "lastName": "Smith" },
      "product": { "name": "Pro Plan" },
      "order": { "amount": 4999, "currency": "usd", "sessionId": "cs_test_123" }
    }
  }'
# -> { "success": true }   (payment email, subject "Potwierdzenie płatności - cs_test_123")
```

## Security model

- **Origin allowlist (public mode):** only listed origins may submit; CORS reflects the
  exact origin, never `*`.
- **Turnstile:** every public submission is verified server-side against Cloudflare; the
  verifier fails closed on network/parse errors.
- **Honeypot:** a filled `botcheck` field is silently dropped (looks like success to bots).
- **Fixed recipient / anti-relay:** the recipient is always `brand.to` from server config
  in public mode. `to`/`from` in the request body are ignored, so the endpoint can never be
  used as an open relay. Covered by a regression test.
- **Rate limit:** KV-backed fixed window (8/hour per brand+IP) blocks bursts. Degrades open
  if the KV binding is missing so a misconfig never takes the form offline silently.
- **Bearer compare:** trusted-mode token is compared in constant time.
- **Output escaping:** every field value is HTML-escaped before rendering (no stored/reflected XSS).
- **Size/shape guards:** body capped at 64 KB, ~40 fields, 5000 chars/value; non-object JSON rejected.
- **No secrets in code:** SES/Turnstile/API credentials are read from `env` at runtime only.

## Secrets

Set with `wrangler secret put <NAME>` (values live only in Cloudflare, never in git):

```bash
wrangler secret put SES_ACCESS_KEY_ID      # AWS IAM access key id (scope to ses:SendEmail)
wrangler secret put SES_SECRET_ACCESS_KEY  # AWS IAM secret access key
wrangler secret put TURNSTILE_SECRET       # Cloudflare Turnstile secret key
wrangler secret put API_KEY                # long random bearer for trusted mode
```

For local `wrangler dev`, copy `.dev.vars.example` → `.dev.vars` and fill placeholders
(`.dev.vars` is gitignored). The non-secret `SES_REGION` lives in `wrangler.toml [vars]`.

## Deploy notes

1. **Create the KV namespace** and put the ids in `.env` (`MAILSTACK_KV_ID` /
   `MAILSTACK_KV_PREVIEW_ID`); `npm run setup` writes them into the generated `wrangler.toml`:
   ```bash
   wrangler kv namespace create RATE_LIMIT
   wrangler kv namespace create RATE_LIMIT --preview   # for `wrangler dev`
   ```
2. **Verify the SES sender(s)** (domain or email identity) in the SES console for the
   region in `SES_REGION` (default `eu-west-1`), and move the account out of the SES
   sandbox so it can mail arbitrary recipients.
3. **Set the secrets** (see above).
4. **Deploy:** `wrangler deploy`.
5. **Custom domain:** add a route / custom domain (e.g. `mail.example.com`) to the Worker
   in the Cloudflare dashboard or via `wrangler`.
6. **Frontends:** point each site's form at `POST /v1/send` with the right `brand`, and add
   the Cloudflare Turnstile widget so a `cf-turnstile-response` token is included.

## Code layout

```
src/
  index.ts             router (health, /v1/send + CORS preflight, /v1/hooks/sellf, brand logo asset)
  send.ts              POST /v1/send handler: modes, validation, template select, anti-relay, auto-reply; shared renderAndSend + bearer helpers
  sellf.ts             POST /v1/hooks/sellf handler: Sellf event -> template mapping (SELLF_EVENT_MAP)
  turnstile.ts         Turnstile siteverify (injectable)
  ses.ts               Amazon SES v2 send via aws4fetch (injectable)
  brands.ts            brand data (gitignored — copy from brands.example.ts via `npm run setup`)
  brands.example.ts    demo brand registry (committed)
  registry.ts          getBrand / findBrandByOrigin (imports from brands.ts)
  templates.ts         back-compat shim (re-exports escapeHtml/humanizeLabel/renderEmail)
  templates/
    layout.ts          shared brand chrome + helpers (escapeHtml, paragraph, summaryTable, ctaButton)
    index.ts           template registry + getTemplate + legacy renderEmail wrapper
    types/contact.ts   contact form (publicAllowed) — the original behavior
    types/welcome.ts   onboarding / welcome
    types/received.ts  submission acknowledgement
    types/payment.ts   payment confirmation
    types/notice.ts    generic catch-all
  ratelimit.ts         KV fixed-window limiter
  cors.ts              origin allowlist + CORS headers
  types.ts             shared types (Env, Brand, TemplateDef, SendDeps, ...)
test/                  vitest suites (pure functions + handler with mocked deps)
```

Side effects (Turnstile verify, SES send, clock) are injected via a `SendDeps` object so
the handler is unit-testable without network or the Workers runtime.

## Commands

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run test        # vitest run
npm run dev         # wrangler dev (needs .dev.vars + KV preview id)
npm run deploy      # wrangler deploy
```

## TODO (infra/deploy)

- Copy `.env.example` → `.env` and set `MAILSTACK_KV_ID` / `MAILSTACK_KV_PREVIEW_ID` (+ optional `MAILSTACK_ROUTE`).
- Run `npm run setup` — generates `wrangler.toml` from `.env` and creates `src/brands.ts` + `src/assets/logo.ts` from the examples.
- Edit `src/brands.ts` with your real brand(s). (Don't edit the generated `wrangler.toml` — change `.env` instead.)
- Set the four secrets (`SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `TURNSTILE_SECRET`, `API_KEY`).
- Verify SES senders (domain/email identity for each `from` address) and leave the SES sandbox.
- Add a custom domain/route for the Worker.
- Replace `src/assets/logo.ts` with your own PNG (base64-encoded) and update `brand.theme.logoUrl`.
