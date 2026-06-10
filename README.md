[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/your-org/mailstack/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/mailstack/actions/workflows/ci.yml)

# mailstack

A self-hostable **form-to-email and transactional email sender** running on a single
Cloudflare Worker. Post a JSON payload from your browser form or server; mailstack
validates it, renders a branded HTML email, and delivers it via **Amazon SES**.

Multi-tenant by design: each brand has its own sender address, fixed recipient list,
origin allowlist, and visual theme. Public submissions are gated by Cloudflare Turnstile,
a honeypot, origin enforcement, and a KV-backed rate limiter. Server-to-server sends use
a bearer token and bypass the browser-only checks. An optional Sellf webhook adapter
converts e-commerce events (purchase, refund, waitlist, etc.) into branded transactional
emails without extra code.

## Features

- **Multi-brand**: any number of tenants in one Worker; brand resolved from `?brand=` or
  the request `Origin`.
- **Anti-relay**: recipient is always the server-side `brand.to` — the request body can
  never redirect mail.
- **Two modes**: public (Turnstile + origin + honeypot + rate limit) and trusted
  (Bearer token, for server-to-server sends).
- **Template types**: `contact` (public), `welcome`, `received`, `payment`, `notice` —
  all sharing one per-brand branded layout.
- **Auto-reply**: optional confirmation back to the form submitter, dispatched
  non-blocking via `ctx.waitUntil`.
- **Sellf webhook adapter**: maps `purchase.completed`, `refund.issued`, `waitlist.signup`,
  `lead.captured`, `access.expired` to branded emails; unknown events are silently acked.
- **No database**: rate limit in KV, everything else stateless.
- **Secret scanning**: TruffleHog pre-commit hook + CI gate.

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Bootstrap business config (brands.ts, assets/logo.ts) — wrangler.toml is already in the repo
npm run setup

# 3. Edit your brand(s)
$EDITOR src/brands.ts

# 4. Edit deployment config
$EDITOR wrangler.toml

# 5. Create KV namespace for rate limiting
wrangler kv namespace create RATE_LIMIT
wrangler kv namespace create RATE_LIMIT --preview
# Paste the output ids into wrangler.toml

# 6. Set secrets
wrangler secret put SES_ACCESS_KEY_ID
wrangler secret put SES_SECRET_ACCESS_KEY
wrangler secret put TURNSTILE_SECRET
wrangler secret put API_KEY

# 7. Deploy
npm run deploy
```

## Config

`wrangler.toml` is committed — it holds no secrets, just KV ids and your domain (edit it for
your deployment). Your **business** config is gitignored and bootstrapped from a committed
example, so the public repo never leaks private data:

| Real file (gitignored) | Example template | Purpose |
|---|---|---|
| `src/brands.ts` | `src/brands.example.ts` | Brand registry (sender, recipients, theme) |
| `src/assets/logo.ts` | `src/assets/logo.example.ts` | Brand logo PNG (base64) |

`npm run setup` copies each example to the real location if it's missing (it also runs before
`dev`/`test`/`typecheck`/`deploy`). Edit the real files — **never the `.example` ones**.
Secrets live in no file at all — set them with `wrangler secret put` (see Quick start).

### Adding a brand

Edit `src/brands.ts` and append an entry:

```ts
acme: {
  id: "acme",
  name: "Acme Inc.",
  from: "Acme Inc. <hello@acme.example>",   // verified SES sender
  to: ["inbox@acme.example"],               // fixed recipient — never overrideable
  allowedOrigins: [
    "https://acme.example",
    "https://www.acme.example",
    "http://localhost:4321",
  ],
  subjectPrefix: "New message from",
  autoReply: true,                          // send confirmation to the submitter
  theme: {
    accent: "#0064BC",
    accent2: "#A8D603",
    logoUrl: "https://mail.example.com/brand/logo.png",
    siteUrl: "https://acme.example",
    address: "123 Example Street, City",
    phone: "+00 000 000 000",
  },
},
```

Redeploy after editing. No code changes needed elsewhere.

## API

### `GET /health`

Liveness check.

```json
{ "ok": true, "service": "mailstack" }
```

### `OPTIONS /v1/send`

CORS preflight. Returns `204` + CORS headers when the `Origin` is allowed for the brand,
`403` otherwise.

### `POST /v1/send`

Main send handler. Always returns `{ success: boolean, message?: string }`.

**Control keys** (stripped before rendering):

| Key | Description |
|---|---|
| `brand` | **required** — brand id |
| `cf-turnstile-response` | Cloudflare Turnstile token (public mode) |
| `botcheck` | honeypot — must be absent or empty |
| `subject` | subject override (trusted mode only) |
| `to` | recipient override (trusted mode only, validated) |
| `replyTo` | Reply-To override (trusted mode only, validated) |
| `template` | template type (trusted mode only; public is always `contact`) |
| `autoreply` | per-request auto-reply toggle (`1`/`true` or `0`/`false`) |

Everything else is treated as a content field (`name`, `email`, `message`, etc.).

**Public mode** (no bearer): enforces Origin allowlist, honeypot, Turnstile, rate limit,
fixed recipient.

**Trusted mode** (`Authorization: Bearer <API_KEY>`): skips browser checks; allows
`template`, `subject`, `to`, `replyTo` overrides.

```bash
# Public form submission
curl -X POST https://mail.example.com/v1/send \
  -H 'content-type: application/json' \
  -H 'origin: https://acme.example' \
  -d '{
    "brand": "acme",
    "name": "Jane Smith",
    "email": "jane@example.com",
    "message": "Hello!",
    "cf-turnstile-response": "<token-from-widget>"
  }'

# Trusted transactional send (payment receipt)
curl -X POST https://mail.example.com/v1/send \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $MAILSTACK_API_KEY" \
  -d '{
    "brand": "acme",
    "template": "payment",
    "to": "buyer@example.com",
    "name": "Jane Smith",
    "amount": "49.99",
    "currency": "USD",
    "item": "Pro Plan",
    "orderId": "ORD-1001"
  }'
```

### `POST /v1/hooks/sellf`

Sellf webhook adapter. Bearer-only. Optional `?brand=<id>` (defaults to the first brand
or the `SELLF_DEFAULT_BRAND` var). Maps Sellf events to branded emails; unmapped events
and invalid/missing recipients are acked without sending (so Sellf does not retry).

## Templates

| `template` | Purpose | Public? |
|---|---|---|
| `contact` | Contact-form submission | Yes |
| `welcome` | Onboarding / welcome | No |
| `received` | Submission acknowledgement | No |
| `payment` | Payment confirmation | No |
| `notice` | Generic catch-all | No |

### Adding a template

1. Create `src/templates/types/<id>.ts` exporting a `TemplateDef`.
2. Register it in `src/templates/index.ts`.
3. Add a test in `test/template-types.test.ts`.

## Security model

- **Origin allowlist**: only listed origins may submit; CORS reflects the exact origin,
  never `*`.
- **Turnstile**: every public submission verified server-side; fails closed.
- **Honeypot**: silently swallowed; looks like success to bots.
- **Fixed recipient / anti-relay**: `brand.to` is server-side only; body `to`/`from` are
  ignored in public mode.
- **Rate limit**: KV fixed window — 8 requests/hour per brand+IP.
- **Bearer token**: constant-time comparison.
- **Output escaping**: all field values HTML-escaped before rendering.
- **Size guards**: body capped at 64 KB, ~40 fields, 5000 chars/value.
- **No secrets in code**: SES/Turnstile/API credentials read from `env` at runtime.

## Secret scanning

TruffleHog runs as a pre-commit hook (see `.husky/pre-commit`) and in CI
(`.github/workflows/secret-scan.yml`). The pre-commit hook skips gracefully if
`trufflehog` is not installed locally, but CI always enforces it.

Install locally: `brew install trufflehog`

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in the secret values
npm run dev                       # wrangler dev with KV preview
```

## License

MIT. See [LICENSE](LICENSE).
