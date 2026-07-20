# mailstack — Bruno API collection

A [Bruno](https://www.usebruno.com/) collection that exercises every endpoint of
the mailstack Worker: the public contact form (Turnstile **and** Altcha brands),
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
| `apiKey`  | `your-api-key-here`      | Trusted-mode bearer — must match the `API_KEY` secret |

Then pick the environment from Bruno's top-right selector before sending.

### Pointing at a local `wrangler dev`

```bash
npm run dev   # wrangler dev, serves http://localhost:8787
```

`wrangler dev` reads secrets from `.dev.vars` (copy `.dev.vars.example`). For the
public **Turnstile** contact requests to pass locally, set Cloudflare's official
always-pass testing secret:

```
API_KEY=some-long-local-key            # must equal the collection's {{apiKey}}
TURNSTILE_SECRET=1x0000000000000000000000000000000AA
ALTCHA_HMAC_KEY=any-local-hmac-key     # needed for the demo brand's Altcha flow
```

With that Turnstile secret, **any** `cf-turnstile-response` token verifies, so the
collection's literal `"test-token"` works with no real widget. (Matching site key
for a real widget: `1x00000000000000000000AA`.) These are public Cloudflare
documentation values, not secrets.

> Note: a successful `/v1/send` still needs a working SES path — real
> `SES_ACCESS_KEY_ID`/`SES_SECRET_ACCESS_KEY` **and** a `from` address on a domain
> verified in that SES account (the example brands' `hello@acme.example` /
> `noreply@demo.example` are placeholders and will make SES reject the send with
> `502 send failed`; point `from` at your own verified domain to test a real
> send). The gate-only requests (honeypot, blocked origin, 401, 400, 413,
> unmapped webhook) don't touch SES at all and pass regardless.
>
> The whole collection (all 34 requests) was verified green against a real local
> `wrangler dev` + real SES credentials + a verified sender domain: `bru run
> --env local` → 34/34 requests, 79/79 assertions passed, including the Altcha
> proof-of-work solve script and the full `trackAction`/ParcelDelivery directive.

### Pointing at a deployed instance

Fill `environments/production.bru` with your Worker's custom domain and the real
`API_KEY`. Public-mode requests then need a real allowlisted `Origin` and, for
Turnstile brands, a genuine widget token instead of `test-token`.

## Folders

| Folder                  | What it covers                                                        |
|-------------------------|----------------------------------------------------------------------|
| `health/`               | `/health` liveness + CORS preflight (allowed / blocked origin)        |
| `public-contact/`       | Public contact form (Turnstile): success, honeypot, blocked origin, autoreply opt-out |
| `public-contact-altcha/`| Two-step Altcha flow: fetch challenge → solve proof-of-work → submit  |
| `trusted-send/`         | Transactional templates: welcome, received, payment, notice, overrides |
| `markup/`               | All schema.org markup directives + the merge rule (auto vs explicit vs empty) |
| `sellf-webhook/`        | Every Sellf event mapping + unmapped-event ack + missing-auth 401     |
| `errors/`               | Unknown brand (400), invalid JSON (400), payload too large (413)      |

## The two brands

The collection uses only the two committed example brands (`src/brands.example.ts`):

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

The Altcha pair must run in order (challenge → solve); Bruno runs a folder in
`seq` order, which the filenames enforce.
