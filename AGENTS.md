# mailstack

A universal, secure **form-to-email + transactional email sender** running on a
Cloudflare Worker (D1 + SES) or Node (SQLite + SES/SMTP). Self-owned alternative to Web3Forms: your forms POST here, the Worker
validates and renders a branded email, and sends it via **Amazon SES** or **SMTP**. Multi-tenant by
design — each "brand" has its own sender, fixed recipient, origin allowlist, and theme.

Stack: TypeScript (strict), `aws4fetch` for SES SigV4, Nodemailer for SMTP, Kysely with
D1/SQLite for logging and atomic guards. Worker entry: `src/index.ts`; Node entry:
`src/runtime/node-api.ts`. Installation, keys, policies, event setup, retention and
ntfy operations are documented in [README.md](README.md).

## Public API

Base URL is wherever the Worker is deployed (e.g. `https://mail.example.com`).

### `GET /health`
Liveness check.
```json
{ "ok": true, "service": "mailstack", "version": "1.0.0", "commit": "dev" }
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
Main handler. Responds with JSON `{ success: boolean, message?: string, code?: string, id?: string, idempotent?: true }`. The
`Access-Control-Allow-Origin` header is echoed only when the origin is allowed for the brand.

Request body is **flat JSON**: a few control keys plus arbitrary content fields.

| Control key | Meaning |
|---|---|
| `brand` | Brand id (`acme`, `demo`, ...); falls back to `?brand=<id>` when empty or omitted. Different nonempty body and query brands return `400 brand mismatch`. |
| `cf-turnstile-response` | Cloudflare Turnstile token (public mode) |
| `altcha` | Base64 ALTCHA solution for brands with `captcha: "altcha"` |
| `botcheck` | honeypot — must be empty/absent |
| `access_key` | reserved (prefer the bearer header for trusted mode) |
| `subject` | subject override (trusted mode only) |
| `to` | recipient override (trusted mode only, validated) |
| `replyTo` | Reply-To override (trusted mode only, validated) |
| `template` | email type to render (trusted mode only); public is always `contact` |
| `autoreply` | per-request toggle for the submitter confirmation (`1`/`true`/`yes`/`on` vs `0`/`false`); overrides `brand.autoReply`. See [Auto-reply](#auto-reply). |
| `ref` | trusted correlation string (1-128 characters) |
| `resendOf` | trusted: reserved, return `400 not_supported`; public: ignored |
| `attachments` | trusted client with `attachments: true`: array of `{ filename, contentType, contentBase64 }`; public: ignored |
| `markup` | trusted JSON-LD directives; ignored in public mode |
| `nonce`, `product` | controls only for public brands with `requireNonce: true`; otherwise content |
| `_meta` | reserved, ignored as content |

Everything else (`name`, `email`, `phone`, `message`, `type`, `topic`, `person`, `gdpr`,
or any custom key) is treated as a **content field** and fed to the selected template.
See [Templates](#templates) for the per-type fields.

## Two modes

### Public mode (browser forms)
No bearer token (or an invalid one). The Worker enforces **all** of:
1. **Origin allowlist** — `Origin` must be in `brand.allowedOrigins`, else `403 origin not allowed`.
2. **Honeypot** — a non-empty `botcheck` returns `200 {success:true}` and sends nothing.
3. **Captcha** — Turnstile by default, or ALTCHA when `brand.captcha` is `altcha`.
   ALTCHA challenges from `GET /altcha/challenge?brand=<id>` expire after 10 minutes;
   the expiry is included in the signed salt (`?expires=<unix-seconds>`). Missing,
   invalid, or elapsed expiry returns `403 verification failed`. A verified solution
   is atomically recorded in D1 before sending. Subsequent uses return the same 403.
   Missing storage or write errors also return 403. Trusted mode skips guards.
4. **Rate limit** — D1 fixed window, 8 requests/hour per `brand`+IP, else `429`.
   The rate limiter degrades open when storage is missing or fails; captcha is still required.
5. **Fixed recipient** — mail always goes to `brand.to`; any `to`/`from` in the body is ignored (anti-relay).

ALTCHA records expire at the signed validity timestamp. Fetch and solve a new challenge
for each submission, including retries after a delivery failure. Atomic insertion allows
only one concurrent submission to consume the same solution.

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
Send `Authorization: Bearer <token>` for a configured client with `send` scope and
allowed brand/template, or the enabled legacy `API_KEY`. This skips public guards and allows:
- a `template` selection (any registered type — see [Templates](#templates); public is
  always pinned to `contact`),
- a `subject` override,
- a validated `to` override when `recipientOverride: true` (valid email(s), capped to 5),
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
| 413 | `payload too large` | body > 64 KiB (10 MiB for attachment-enabled send clients) |
| 415 | `attachment type not allowed`, code `attachment_type` | MIME type outside attachment allowlist |
| 422 | `invalid attachment`, code `attachment_invalid` | invalid attachment shape, name, base64, signature or decoded limits |
| 429 | `rate limit exceeded` | public-mode rate limit hit |
| 502 | `send failed` | SES returned a non-2xx response |

## Brands config

Brands live under `brands` in the external `mailstack.json` selected by `MAILSTACK_CONFIG`, keyed by short id:

```ts
interface Brand {
  id: string; name: string;
  from: string;            // verified SES sender, e.g. "Foo <info@foo.example>"
  to: string[];            // fixed public recipient(s)
  allowedOrigins: string[];
  subjectPrefix: string;
  theme: { accent: string; accent2?: string; logoUrl?: string; siteUrl: string; address?: string; phone?: string; };
  captcha?: "turnstile" | "altcha";
  turnstileAction?: string;
  requireNonce?: boolean;
  products?: string[];
  autoReply?: boolean;         // default for the contact auto-reply (default false). See Auto-reply.
  autoReplyTemplate?: string;  // template used for the auto-reply (default "received")
}
```

Example brands in `config/mailstack.example.json`: `acme` (auto-reply on) and `demo`. Copy the JSON outside the repository and export `MAILSTACK_CONFIG`. Node 24+ runs the TypeScript CLI directly: `node scripts/mailstack.ts config check <file>` or `config import-brands <legacy-brands.ts>` (JSON stdout; trusted local input).

The zod schema in `src/core/config/schema.ts` validates brands and logging at boot with JSON-path errors. Clients, legacyApiKey, sender and events.ses are optional validated sections; alerts is reserved and uninterpreted. Node uses `loadNodeConfig()`; Worker setup bundles validated JSON and records `BUILD_CONFIG_SHA` in Wrangler vars. The custom build verifies the input hash. `includeSecrets` needs an audit sink at boot; both runtime loaders currently reject it; keep includeSecrets false. Tests/typecheck generate the example bundle; rerun setup with the external config before building.

For a complete validated JSON example and legacy migration commands, see
[configuration](README.md#complete-configuration-example) and
[registry migration](README.md#migrating-a-legacy-brand-registry). Logging levels,
precedence, `secretFields`, `subjectRoles` and policy constraints are described under
[logging policies](README.md#logging-policies). Keep `resend: "off"` in this release.

### Client configuration

```bash
node scripts/mailstack.ts client create --id acme-app --scopes send --brands acme --templates notice,payment
node scripts/mailstack.ts client create --id panel --scopes panel
```

The CLI prints the token once alongside a configuration entry containing `tokenSha256`.
Clients with `send` or `hook:sellf` require explicit `brands` and `templates` (lists or `"*"`);
CLI callers must provide both `--brands` and `--templates` (quote `'*'` for all values).
Panel-only clients may omit these selections, which become empty lists. `legacyApiKey`
retains its wildcard defaults for both fields.

### How to add a brand
1. Append an entry to `brands` in the external JSON with a new id.
2. Set `from` to a **verified SES sender** (domain/identity must be verified in the
   account region, `SES_REGION`).
3. Set `to` to the fixed inbox, list the site's `allowedOrigins`, and fill `theme`.
4. Add a test in `test/brands.test.ts` if you want, then `npm run typecheck && npm run test`.
5. Redeploy.

No code changes are needed elsewhere — `getBrand` / `findBrandByOrigin` read the loaded configuration in `src/core/config/index.ts`.

### Form nonce

Brands can opt into `requireNonce: true` with a nonempty `products` selection.
`GET /altcha/challenge?brand=<id>&product=<name>` from an allowed origin returns
`{altcha, nonce}` instead of the flat ALTCHA challenge. Submit the solution and nonce;
the nonce is valid for ten minutes and is consumed before captcha verification.
The nonce product becomes `type`; fetch a fresh pair for every attempt. Trusted sends
skip this check. See [form instructions](README.md#public-forms-using-altcha) for
product matching, errors and the scope of the `nonce`/`product` control fields.

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
| `license` | License delivery | `name`, `productName`, `tier`, `domain`, `licenseKey`, `activationUrl`, `instructions`; `licenseKey` and `activationUrl` are secret |
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
   bodyText, previewText?, jsonLd? }`, optional `secretFields` and `subjectRoles`). Build HTML with the shared helpers from `../layout`
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

## Email markup (schema.org / Gmail)

Emails can carry **schema.org markup** — a `<script type="application/ld+json">` block in the
`<head>` — so Gmail (and, partially, Yahoo) render **action buttons** in the message bar
(GitHub-style), **Promotions-tab annotations** (deal badge, promo code), or **reservation**
cards. It is not an SMTP header; clients that don't support it ignore it (graceful degradation).

> **Allowlisting caveat:** markup renders to *arbitrary* recipients only after you register the
> sender with Google (sample to `schema.whitelisting+sample@gmail.com`; needs DKIM/SPF, volume,
> low spam). It renders to **your own inbox** and in Google's **Email Markup Tester** with no
> registration — enough to develop and verify. Outlook uses a different format; Apple Mail: none.

### Adding markup

Send a reserved `markup` control key — **trusted mode only** (`Authorization: Bearer <API_KEY>`);
it is ignored for public browser requests, like `to`/`template`. The value is an **array of
directives**, each tagged with `kind`:

```jsonc
{
  "brand": "acme", "template": "payment", "to": "buyer@example.com",
  "amount": "149.00", "orderId": "ORD-7788",
  "markup": [
    { "kind": "viewAction", "name": "See order", "url": "https://acme.example/o/ORD-7788" },
    { "kind": "discountOffer", "discountCode": "WELCOME10", "description": "10% off", "availabilityEnds": "2026-08-01" },
    { "kind": "schema", "type": "ParcelDelivery", "props": { "trackingNumber": "1Z999" } },
    { "kind": "raw", "value": { "@type": "FlightReservation", "reservationId": "ABC123" } }
  ]
}
```

| `kind` | Produces | Key fields |
|---|---|---|
| `viewAction` | `EmailMessage` → `ViewAction` (go-to button) | `name`, `url` (http/https) |
| `confirmAction` | `EmailMessage` → `ConfirmAction` + `HttpActionHandler` (one-click) | `name`, `url` |
| `trackAction` | `ParcelDelivery` + `TrackAction` | `url`, `carrier`, `expectedArrivalUntil`, `orderNumber`, `merchant`, `deliveryAddress` ({streetAddress,addressLocality,addressRegion,addressCountry,postalCode}), `itemShipped` (name string or {name,url,image,sku}) — Gmail's real ParcelDelivery spec requires all of these, not just a url; optional `trackingNumber` |
| `discountOffer` | `DiscountOffer` (Promotions tab) | `discountCode`; optional `description`, `availabilityStarts/Ends` |
| `promotionCard` | `PromotionCard` (image card) | `images` (http/https, ≥1) or `image`; optional `name`, `url` |
| `organization` | `Organization` (logo) | `name`, `logo` (url) |
| `schema` | `{ "@type": <type>, ...props }` | `type`, `props` — any schema.org type |
| `raw` | passthrough of a full JSON-LD object | `value` (plain object with a string `@type`) |

Invalid or unknown directives are **dropped** (fail-soft) — the email still sends. Non-http(s)
action URLs are rejected. Caps: ≤ 5 blocks, ≤ 16 KB total, bounded nesting depth.

### Template auto-markup and the merge rule

A template may derive markup from its own data. Today the **`payment`** template emits a
`ViewAction` when the request carries an `orderUrl` ("Zobacz zamówienie") or `invoiceUrl`
("Pobierz fakturę"). This applies to Sellf emails too, since they render through the same path.

Control is **per request**, no config flags:

- **Omit** `markup` → the template may add its own markup.
- **Include** `markup` (any array) → your blocks win wholesale; template auto-markup is suppressed.
- `"markup": []` → no markup at all for this email.

To make a template emit its own markup, build blocks with the helpers in `src/markup` and return
them as `RenderedBody.jsonLd` (see `src/templates/types/payment.ts`).

## Sellf webhook (`/v1/hooks/sellf`)

`POST /v1/hooks/sellf` turns Sellf webhook events into branded emails to the customer,
reusing the existing templates (no new template types).

- **Auth: Bearer required.** Sellf uses a client with `hook:sellf` scope or the legacy
  API key. Clients with `sellfSignatureSecretEnv` additionally require a valid
  `X-Sellf-Signature` (see Send logging and idempotency below). Missing/invalid
  credentials return `401 {success:false,message:"unauthorized"}`.
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
  verifier fails closed on network/parse errors. Hostname must exactly match a host from
  `brand.allowedOrigins`, configured `turnstileAction` must match, and Siteverify times out after 5 seconds.
- **Honeypot:** a filled `botcheck` field is silently dropped (looks like success to bots).
- **Fixed recipient / anti-relay:** the recipient is always `brand.to` from server config
  in public mode. `to`/`from` in the request body are ignored, so the endpoint can never be
  used as an open relay. Covered by a regression test.
- **Rate limit:** D1-backed fixed window (8/hour per brand+IP). Degrades open when
  storage is missing or fails; public requests still require captcha. ALTCHA single-use
  recording remains fail-closed and returns 403 when storage is unavailable.
- **Bearer compare:** trusted-mode token is compared in constant time.
- **Output escaping:** every field value is HTML-escaped before rendering (no stored/reflected XSS).
- **Markup safety:** JSON-LD is embedded via a JSON-safe serializer that escapes `<` (neutralizes
  a `</script>` breakout) and U+2028/U+2029; action URLs must be http(s); markup is trusted-mode
  only and capped in count/size (never injectable by public requests).
- **Size/shape guards:** body capped at 64 KiB (10 MiB for attachment-enabled send clients), ~40 fields, 5000 chars/value; non-object JSON rejected.
- **No secrets in code:** SES/Turnstile/API credentials are read from `env` at runtime only.

## Delivery events and operations

`POST /v1/events/ses` accepts signed SNS subscription confirmations and SES events.
Configure exact `events.ses.topicArns` and `accountIds`, the runtime keyring and
`SES_CONFIGURATION_SET`; see [SES/SNS setup](README.md#ses-events). Node SMTP records
local relay acceptance; downstream delivery events and DSN polling are not included.

Use [Docker installation](README.md#run-with-docker-node--sqlite) for Node/SQLite.
Keys are managed with [npm run keys](README.md#content-and-index-keys); the API receives
public content keys and index keys, while private content keys stay outside its volume.
Retention runs hourly (Worker minute 17 UTC; Node first after 30 seconds). Node makes
startup/daily SQLite snapshots and keeps seven. See [retention and snapshots](README.md#retention-and-snapshots)
and [ntfy alerts](README.md#ntfy-alerts) for storage lifecycle and notification setup.

## Secrets

Set with `npx wrangler secret put <NAME>` (values live only in Cloudflare, never in git):

```bash
npx wrangler secret put SES_ACCESS_KEY_ID      # AWS IAM access key id (scope to ses:SendEmail)
npx wrangler secret put SES_SECRET_ACCESS_KEY  # AWS IAM secret access key
npx wrangler secret put TURNSTILE_SECRET       # Cloudflare Turnstile secret key
npx wrangler secret put API_KEY                # long random bearer for trusted mode
npx wrangler secret put ALTCHA_HMAC_KEY        # ALTCHA brands
npx wrangler secret put CONTENT_PUBLIC_KEYS    # public JWK set from npm run keys
npx wrangler secret put INDEX_KEYS             # index-key array from npm run keys
```

For local `npx wrangler dev`, copy `.dev.vars.example` → `.dev.vars` and fill placeholders
(`.dev.vars` is gitignored). The non-secret `SES_REGION` lives in `wrangler.toml [vars]`.

## Deploy notes

1. **Create the D1 databases** with `npx wrangler d1 create mailstack` and
   `npx wrangler d1 create mailstack-preview`, then put their ids in `.env`
   (`MAILSTACK_D1_ID` / `MAILSTACK_D1_PREVIEW_ID`). Run `npm run setup`, then
   `npx wrangler d1 migrations apply DB --local` for development or `--remote` before deploy.
2. **Verify the SES sender(s)** (domain or email identity) in the SES console for the
   region in `SES_REGION` (default `eu-west-1`), and move the account out of the SES
   sandbox so it can mail arbitrary recipients.
3. **Set the secrets** (see above).
4. **Deploy:** `npm run deploy`. The guard runs before setup, fetches `origin/main`,
   and requires a clean tree plus HEAD equal to `origin/main` or tagged and reachable
   from it. It passes HEAD as `BUILD_COMMIT` to Wrangler. Export `MAILSTACK_HEALTH_URL`
   (the full `/health` URL) to verify the deployed commit; without it the check is
   explicitly skipped. `/health.version` comes from package.json; commit defaults to `dev`.
   Release tags `v*` run checks and publish the container image; the private-config
   Worker deploy workflow is deferred. See README for release tags and local Compose.
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
  core/config/         strict schema, Node/Worker loaders, brand lookups, generated bundle
  templates.ts         back-compat shim (re-exports escapeHtml/humanizeLabel/renderEmail)
  templates/
    layout.ts          shared brand chrome + helpers (escapeHtml, paragraph, summaryTable, ctaButton)
    index.ts           template registry + getTemplate + legacy renderEmail wrapper
    types/contact.ts   contact form (publicAllowed) — the original behavior
    types/welcome.ts   onboarding / welcome
    types/received.ts  submission acknowledgement
    types/payment.ts   payment confirmation
    types/notice.ts    generic catch-all
  markup/              schema.org email markup (JSON-LD)
    builders.ts        typed builders (viewAction, discountOffer, ...) + generic schema()/raw()
    serialize.ts       safe JSON-in-<script> serialization (neutralizes </script>) + head assembly
    index.ts           buildBlocks() — validate/fail-soft/cap; re-exports builders + serialize
  runtime/             Node listener, SMTP/SES selection, maintenance and SQLite setup
  events/              SNS verification and SES event normalization
  core/store/          Kysely D1/SQLite drivers, migrations, audit and backup
  core/logging/        policy resolution, projection and delivery logging
  core/retention.ts    expiry cleanup and stale-send reconciliation
  adapters/            SMTP sender and ntfy notifier
  ratelimit.ts         store-backed fixed-window limiter
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
npm run dev         # npx wrangler dev (needs .dev.vars + D1 preview id)
npm run deploy      # guarded Wrangler deploy
```

## TODO (infra/deploy)

- Copy `.env.example` → `.env` and set `MAILSTACK_D1_ID` / `MAILSTACK_D1_PREVIEW_ID` (+ optional `MAILSTACK_ROUTE`).
- Run `npm run setup` — generates `wrangler.toml` from `.env` and bundles the external `MAILSTACK_CONFIG` and creates `src/assets/logo.ts` from its example.
- Edit the external JSON with your real brand(s). (Don't edit the generated `wrangler.toml` — change `.env` instead.)
- Set the provider, captcha and logging keys described in README, plus trusted credentials.
- Verify SES senders (domain/email identity for each `from` address) and leave the SES sandbox.
- Add a custom domain/route for the Worker.
- Replace `src/assets/logo.ts` with your own PNG (base64-encoded) and update `brand.theme.logoUrl`.

## Send logging and idempotency

All outgoing mail, including public submissions and auto-replies, uses the logging
pipeline before contacting the configured provider. The effective `logging` policy
comes from global, brand, and template settings. `requireLog: true` returns `503` with `code: "log_unavailable"`
without sending if the intent cannot be recorded. With `requireLog: false`, delivery
continues without a log when storage or keys are unavailable. `level: "none"` writes no
message row and needs no encryption keys. With an idempotency key, it stores only a
client-scoped hash in `guards`, expiring after 24 hours. Missing or unavailable storage
allows delivery without deduplication, even with `requireLog: true` at level `none`.

Trusted `POST /v1/send` requests accept:

| Input | Contract |
|---|---|
| `ref` | Optional string of 1-128 characters; otherwise `400 invalid_ref`. Stored encrypted with a correlation index. |
| `Idempotency-Key` header | Optional `[A-Za-z0-9._:-]{1,128}`; otherwise `400 invalid_idempotency_key`. |
| `resendOf` | Reserved for a later phase; its presence returns `400 not_supported`. |
| `attachments` | Array of `{ filename, contentType, contentBase64 }`; requires `attachments: true` on a trusted client. |

These keys are excluded from template content. Public requests ignore them and the
idempotency header. Trusted responses include `id: "msg_..."` whenever the send has a
message row; public response shapes are unchanged. Successful Sellf response shapes
are also unchanged. Provider failures retain `message: "send failed"`, with additive
`code: "send_failed"` and HTTP `502`.

Idempotency keys are scoped to the authenticated client (`legacy` for the legacy API
key; public sends use client id `public` without deduplication). At level `none`, a
repeated key returns `200 {success:true,idempotent:true}` without an `id` or another
send, including while the original attempt is pending or its outcome is uncertain.
Explicit provider refusal releases the key for retry; preparation errors leave it
available. Success and uncertain outcomes retain the key until expiry and guard cleanup.
Only levels `meta`, `masked` and `full` detect conflicts when the same key has a different
request body. At those levels, a matching request follows this table:

| Original state | Repeated request |
|---|---|
| `sent` or a later delivery state | `200 {success:true,id,idempotent:true}` without another send |
| `sending` | `409`, `code: "in_progress"` |
| `send_failed` (explicit provider refusal) | Clear the old key and execute a new attempt |
| `unknown` (exception, timeout, or uncertain result) | `409`, `code: "outcome_unknown"`; no automatic retry |
| Different request with the same key | `409`, `code: "idempotency_conflict"` |

An `unknown` result needs provider reconciliation before considering another send.
The operator panel and resend endpoints are not included in this release. The SES
adapter makes one request per attempt. No idempotency key
means no deduplication. Generated contact receipt timestamps do not change request
identity; recipient, subject, content, Reply-To, ref and explicit markup do.

Sellf requires a Bearer client with `hook:sellf` scope. If that client configures
`sellfSignatureSecretEnv`, the corresponding runtime secret and a valid
`X-Sellf-Signature: t=<unix>,v1=<hex>` are additionally required. The signature is
HMAC-SHA256 over `${t}.${rawBody}` with a 300-second tolerance. Missing or invalid
signatures return `401 unauthorized`. Configure the secret in the runtime, never in
the JSON file. Sellf uses automatic idempotency key
`sellf:<event>:<order.sessionId|order.paymentIntentId|payment.sessionId|payment.paymentIntentId|sha256(rawBody)[0:32]>`
and the order/payment identifier as `ref` when present. Duplicate delivery sends once;
conflicts, pending attempts and unknown outcomes follow the table above.

Set optional `SES_CONFIGURATION_SET` in `.env` and run `npm run setup` to include it in
Worker vars. For local `npx wrangler dev`, it may also be set in `.dev.vars`. Only sends
with a message row include `ConfigurationSetName` and tags `ms_id` (message id),
`ms_brand` (brand id). SES `MessageId` and the encrypted response body are recorded;
response headers are excluded. No open/click tracking configuration is sent.

### Attachments

Trusted send clients must set `attachments: true` in their configuration (default false,
including the legacy key). Public requests ignore the `attachments` control key.

```json
{"brand":"acme","template":"notice","attachments":[{"filename":"note.txt","contentType":"text/plain","contentBase64":"SGVsbG8="}]}
```

Allowed MIME types and extensions: `application/pdf` (`.pdf`), `image/png` (`.png`),
`image/jpeg` (`.jpg`, `.jpeg`), `text/plain` (`.txt`), `text/csv` (`.csv`),
`text/calendar` (`.ics`), `application/xml` and `text/xml` (`.xml`). Filenames must
match `[\w .()-]{1,100}` and have a matching extension. Base64 must be canonical,
with padding and no whitespace. PDF, PNG and JPEG require matching magic bytes.
Maximum: 5 files and 7 MiB decoded in total. Request bodies remain limited to
64 KiB; authenticated send clients with attachment permission have a 10 MiB limit.
Both declared and streamed body sizes are checked before parsing.

Missing client permission returns `403` with `code: "scope"`; unsupported MIME types
return `415 attachment_type`; invalid shape, filename, base64, magic bytes, count or
decoded total returns `422 attachment_invalid`. Oversized bodies return `413` with
`message: "payload too large"`.

SES uses `Content.Simple.Attachments`; SMTP receives decoded buffers. Files and their
names are excluded from archives and replays. Only `{count,totalBytes,types}` is stored
in `attachments_meta`. Request MACs include each file's SHA-256, name and type; changing
a file with the same idempotency key returns `409 idempotency_conflict` at levels
`meta`, `masked` and `full`. Level `none` deduplicates by key alone.
