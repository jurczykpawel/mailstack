# mailstack — Bruno API collection

A [Bruno](https://www.usebruno.com/) collection of public API examples for
the mailstack Worker or Node API: the public contact form (Turnstile **and** Altcha brands),
trusted/transactional sends, schema.org email markup, the Sellf webhook, and the
error paths. Every request carries a `docs` block explaining what it demonstrates
and an `assert` block checking at least the status code.

## Import

1. Install Bruno (desktop app or `bru` CLI).
2. **Open Collection** → point it at this `bruno/` folder. Bruno reads
   `bruno.json` and loads the folders below.

## Environments

Two environment templates live in `environments/`. They are committed as
`*.bru.example`; the real `*.bru` files are gitignored (they hold your base URL
and API key). Copy the template you need and fill it in:

```bash
cp environments/local.bru.example      environments/local.bru
cp environments/production.bru.example environments/production.bru
```

| Var       | Local default            | Meaning                                             |
|-----------|--------------------------|-----------------------------------------------------|
| `baseUrl` | `http://localhost:8787`  | Where the Worker is reachable                       |
| `apiKey`  | `your-api-key-here`      | Full `API_KEY`, or a permitted Pro client (see below) |

The whole collection assumes the full key with attachments disabled (the 413
example uses the 64 KiB limit). A restricted Pro send client needs `send`, the
used brands/templates and `recipientOverride: true`.

Sellf examples require a `hook:sellf` client with brand `acme` and templates
`payment,refund,notice,welcome`, or the full API key (enabled by default).
The examples assume no configured signing secret. With `signatureSecretEnv`
(on a Pro client or `legacyApiKey`), add `X-Sellf-Signature` computed over the exact
serialized request bytes as documented in the main README. Bearer remains required.
Known unsupported events return `422 unsupported_event`; only unknown events are
acknowledged with `200 ignored`. A missing required refund field returns
`422 invalid_event_data`. Successful delivery assertions assume an available
provider and logging configuration; they are not gate-only checks.

Then pick the environment from Bruno's top-right selector before sending.

### Pointing at a local `wrangler dev`

```bash
npm run dev   # wrangler dev, serves http://localhost:8787
```

`wrangler dev` reads secrets from `.dev.vars` (copy `.dev.vars.example`). Public Turnstile sends require a widget token whose Siteverify response has a
hostname matching `brand.allowedOrigins` and action matching `turnstileAction`
(`contact` in the example). The literal `test-token` is a placeholder: an
always-pass test secret alone does not bypass these checks. For offline gate
coverage use `test/turnstile.test.ts` and injected verifiers in handler tests.
For a real local send use a widget on an allowed origin with action `contact`,
put its token in the request and configure its matching secret in `.dev.vars`.
Set `API_KEY` to match `{{apiKey}}` and `ALTCHA_HMAC_KEY` for the demo ALTCHA flow.

> Note: a successful `/v1/send` still needs a working SES path — real
> `SES_ACCESS_KEY_ID`/`SES_SECRET_ACCESS_KEY` **and** a `from` address on a domain
> verified in that SES account (the example brands' `hello@acme.example` /
> `noreply@demo.example` are placeholders and will make SES reject the send with
> `502 send failed`; point `from` at your own verified domain to test a real
> send). The gate-only requests (honeypot, blocked origin, 401, 400, 413,
> unmapped webhook) don't touch SES at all and pass regardless.

### Pointing at a deployed instance

Fill `environments/production.bru` with your Worker's custom domain and the real
`API_KEY`. Public-mode requests then need a real allowlisted `Origin` and, for
Turnstile brands, a genuine widget token instead of `test-token`.

This is a sending API collection, not coverage of the Pro internal/panel API or
all supported source events. Mailstack renders and sends; the caller owns business
rules, webhook authenticity and scheduling. The core [architecture](../docs/architecture.md)
describes profiles a/b/c. The same public API works in all three.

## Folders

| Folder                  | What it covers                                                        |
|-------------------------|----------------------------------------------------------------------|
| `health/`               | `/health` liveness + CORS preflight (allowed / blocked origin)        |
| `public-contact/`       | Public contact form (Turnstile): success, honeypot, blocked origin, autoreply opt-out |
| `public-contact-altcha/`| Two-step Altcha flow: fetch challenge → solve proof-of-work → submit  |
| `trusted-send/`         | Transactional templates: welcome, received, payment, notice, overrides |
| `markup/`               | All schema.org markup directives + the merge rule (auto vs explicit vs empty) |
| `sellf-webhook/`        | Supported Sellf send mappings + unknown-event ack + missing-auth 401     |
| `errors/`               | Unknown brand (400), invalid JSON (400), payload too large (413)      |

## The two brands

The collection uses only the two committed example brands (`config/mailstack.example.json`):

- **`acme`** — Turnstile captcha, `autoReply: true`, allowlists `https://acme.example`.
- **`demo`** — Altcha (self-hosted proof-of-work) captcha, allowlists `https://demo.example`.

Their `*.example` domains are placeholders — never real senders/recipients.

## Public vs trusted mode

The collection default (`collection.bru`) is **trusted mode**: every request
inherits `Authorization: Bearer {{apiKey}}`. Requests that must run in **public
mode** (the contact form, the Altcha flow, CORS preflight, health, and the
webhook 401 case) override this with `auth: none` — otherwise a valid bearer would
flip them into trusted mode and skip the very gates they demonstrate.

## Running the whole collection

With the `bru` CLI:

```bash
bru run --env local
```

The Altcha pair must run in `seq` order (challenge → solve). Each challenge
expires after ten minutes and is consumed once before delivery; fetch a new one
for retries, including after a provider failure. These examples assume
`requireNonce` is off. With nonce-enabled brands use the product/nonce flow
from the main README.

Examples use the built-in Polish presentation. External `mailTemplates` patches
can change subjects and copy; opt-in brand languages accept `locale`. See
[template configuration](../docs/templates.md).
