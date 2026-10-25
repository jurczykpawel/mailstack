[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/jurczykpawel/mailstack/actions/workflows/ci.yml/badge.svg)](https://github.com/jurczykpawel/mailstack/actions/workflows/ci.yml)

# mailstack

**Your own email-sending service — a free, self-hosted alternative to Web3Forms / Formspree.**

Put mailstack between your website's contact form (or your app) and your inbox. It catches the
submission, blocks spam, and sends you a clean, branded email. You run it on your own free
Cloudflare account and it sends through Amazon's email service — so there are **no monthly fees**
and your data only ever passes through accounts **you** control.

## Run with Docker (Node + SQLite)

Requires Docker Compose and Node 24+ for key generation. Prepare the local files once:

```bash
npm ci
cp config/mailstack.example.json mailstack.json
mkdir -p secrets
npm run --silent keys -- init secrets/panel-private.json > .env
chmod 600 .env
```

Keep `secrets/panel-private.json` separately from the data volume and its backups; the API
only needs the public key and index key printed into `.env`. Keys are never baked into the image.
Edit `mailstack.json` with your brand settings. Select the global sender with
`"sender": {"type": "smtp"}` or `"sender": {"type": "ses"}` (the default).
Append an `API_KEY` generated with `openssl rand -hex 32` to `.env` for trusted requests.
For SMTP append `SMTP_URL=smtps://user:password@smtp.example.com:465`, or use
`SMTP_HOST`, `SMTP_PORT` (default 587), `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE=true|false`
(default false). With credentials and `secure=false`, STARTTLS is required;
certificate verification remains enabled. Without credentials, STARTTLS remains opportunistic. URL credentials must be percent-encoded.
For SES set `SES_REGION`, `SES_ACCESS_KEY_ID` and `SES_SECRET_ACCESS_KEY` instead.
Public forms also need `TURNSTILE_SECRET` or `ALTCHA_HMAC_KEY` for their configured captcha.

Start the API with one command:

```bash
docker compose up --build -d
```

The API is published on `127.0.0.1:8080` by default. For public traffic, put a reverse
proxy in front and configure `TRUSTED_PROXY` as described below, or deliberately set
`MAILSTACK_BIND=0.0.0.0` to publish on all host interfaces. `/health` reports `store: "ok"` after a database query;
`ok` remains true if storage goes down, while the container healthcheck reports unhealthy.
Use `MAILSTACK_CONFIG` to mount a different configuration file and `MAILSTACK_PORT` to
change the published port. The container runs as a non-root user on a read-only root filesystem;
only `/data` and the `/tmp` tmpfs are writable. The named data volume survives container restarts.
No panel listener is included yet.

`TRUSTED_PROXY` is unset by default: the socket address is used and incoming
`CF-Connecting-IP` and `X-Forwarded-For` are overwritten. Set `TRUSTED_PROXY=cloudflare`
only when requests arrive through a trusted Cloudflare proxy that supplies `CF-Connecting-IP`.
Set `TRUSTED_PROXY=proxy` for exactly one trusted reverse proxy hop: that proxy must
append the real client address to `X-Forwarded-For`; the API uses the last entry.
Restrict direct access to the API when trusting either header. Missing or invalid address
headers fall back to the socket address. Unknown `TRUSTED_PROXY` values stop startup.

Retention first runs after 30 seconds, then hourly. Startup reads the newest backup mtime
from `mailstack-*.db` in `/data/backups` and immediately creates a snapshot if none exists
or the last is at least 24 hours old. Daily SQLite snapshots keep seven copies;
deleted message data can remain in those backups for up to seven days. Back up the data
volume and keys separately. SIGTERM stops accepting requests, drains requests and background
work, stops maintenance, and closes SQLite. Configure a longer `stop_grace_period` if needed.

To try SMTP locally, select `smtp` in the config and run:

```bash
docker compose -p mailstack-smtp -f docker-compose.yml -f docker-compose.test.yml up --build -d
```

Mailpit is available at `http://localhost:8025`. A send records the final SMTP response and
queue identifier, with sealed evidence labelled `smtp-response`. This proves relay acceptance;
it does not prove delivery to the recipient. SMTP refusals become `send_failed`; network
exceptions become `unknown` and are never retried automatically. With multiple recipients,
partial acceptance remains a successful send and per-recipient events record refusals.
Remove the disposable test environment with
`docker compose -p mailstack-smtp -f docker-compose.yml -f docker-compose.test.yml down -v --rmi local`.

For Node without Docker: `npm run build:node`, then `MAILSTACK_CONFIG=/path/to/mailstack.json npm start`.
The process needs a writable `/data` directory. Configuration is read and validated at startup;
invalid configuration stops the process before listening. The Node bundle includes no brand configuration.

## What it does, in plain words

1. Someone fills in the contact form on your website.
2. mailstack checks they're a real person (an invisible spam check) and that the request really
   came from your site.
3. It builds a tidy email and sends it to your inbox.
4. *(Optional)* it sends the visitor an automatic "thanks, we got your message" reply.

You can also call it from your own app to send things like **"payment confirmed"** or
**"welcome"** emails. One mailstack can serve **several websites/brands** at once, each with its
own sender address and look.

## How it works

```
 Your website form ──▶ mailstack (runs on Cloudflare) ──▶ your inbox
                          │  ✓ real person?  (Cloudflare Turnstile)
                          │  ✓ from your site? (allow-list)
                          └─ sends a branded email via Amazon SES
```

You don't run or maintain a server — Cloudflare runs the little program (a "Worker") for you.

## What you'll need

Everything below has a free tier. For a normal contact form you'll likely never pay a cent.

| You need | What it's for | Cost |
|---|---|---|
| A **terminal** + **Node.js** (v20+) | to set up & deploy (copy-paste commands) | free |
| A free **Cloudflare** account | runs mailstack + the spam check | free |
| An **Amazon (AWS)** account | actually sends the emails (Amazon SES) | ~free at low volume |
| ~30–45 minutes, once | first-time setup | — |
| *(optional)* your own **domain** | a nicer URL + sending "from yourname.com" | — |

> **Not a developer?** You'll still open a terminal and paste a handful of commands — that's
> unavoidable for a self-hosted tool — but every step below is spelled out and explained.

---

## Setup — step by step

### 1) Install Node.js and get the code
- Install **Node.js** (the "LTS" version) from [nodejs.org](https://nodejs.org).
- Get this project: on GitHub click **Code → Download ZIP** (or run `git clone <repo-url>`),
  unzip it, and open a **terminal** in that folder.
- Install the project's bits:
  ```bash
  npm install
  ```

### 2) Create a free Cloudflare account
- Sign up at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) (free).
- Connect your computer to it:
  ```bash
  npx wrangler login
  ```
  This opens your browser — click **Allow**. (`wrangler` is Cloudflare's command-line tool; it
  was installed by `npm install`.)

### 3) Set up Amazon SES — this is what actually sends the emails
SES (Simple Email Service) is Amazon's email service. We use it so your emails reach inboxes
instead of the spam folder, for a tiny cost.

1. Create a free account at [aws.amazon.com](https://aws.amazon.com).
2. In the AWS console, open **Amazon SES** and choose a **region** near you (e.g. *Europe
   (Ireland) — eu-west-1*). Note which one — you'll need it in step 5.
3. **Verify the address your emails will come FROM** (e.g. `hello@yourdomain.com`, or even a
   Gmail address to start): SES → **Identities** → **Create identity** → enter the email → SES
   sends you a confirmation link → click it. *(Advanced: verify a whole domain to send from any
   address on it.)*
4. New SES accounts start in **"sandbox" mode** — they can only send *to* addresses you've also
   verified. For a contact form that emails **your own inbox**, just verify your inbox too and
   you're good to go. To email *anyone* (e.g. customers), open **Account dashboard → Request
   production access** (a short form, usually approved within a day).
5. **Create a sending key**: AWS console → **IAM** → **Users** → **Create user** → attach the
   policy **AmazonSESFullAccess** → open the user → **Security credentials → Create access key**.
   Copy the **Access key ID** and **Secret access key** somewhere safe (you'll paste them in
   step 7).

### 4) Create the spam check (Cloudflare Turnstile — free, invisible)
- Cloudflare dashboard → **Turnstile → Add widget**.
- Add your website's domain(s), and add `localhost` so you can test locally.
- Create it, then copy the **Site key** (public — goes on your web page) and the **Secret key**
  (private — goes in step 7).

### 5) Create the rate-limit storage, then fill in `.env`
This caps how often someone can submit, to stop abuse.
```bash
wrangler d1 create mailstack
wrangler d1 create mailstack-preview
```
Each command prints an **id** — copy both. Then create your settings file:
```bash
cp .env.example .env
```
Open **`.env`** and paste the two ids (leave the domain empty for now):
```
MAILSTACK_D1_ID=<the first id>
MAILSTACK_D1_PREVIEW_ID=<the second id>
MAILSTACK_ROUTE=
```

Create the D1 databases above, run `npm run setup` to generate the SQL migration, then apply it with `wrangler d1 migrations apply DB --local` for development or `wrangler d1 migrations apply DB --remote` before deployment.

### 6) Describe your "brand" (who the email is from and to)
Copy `config/mailstack.example.json` to a private location outside this repository, then
export `MAILSTACK_CONFIG` pointing to that file. Use Node 24 or newer (tested on Node 26).
Edit `brands.acme` in that JSON file:
```json
"acme": {
  "id": "acme",
  "name": "My Website",
  "from": "My Website <hello@acme.example>",
  "to": ["inbox@acme.example"],
  "allowedOrigins": ["https://acme.example"],
  "subjectPrefix": "New message from",
  "autoReply": true,
  "theme": { "accent": "#0064BC", "siteUrl": "https://acme.example" }
}
```
You can rename `acme` to anything (e.g. `mysite`). Remember that id — you'll use it when you
connect your form in step 9.

### 7) Add your secret keys (kept safely in Cloudflare, never in any file)
```bash
npm run setup                               # prepares your config from .env

wrangler secret put SES_ACCESS_KEY_ID       # paste the AWS Access key ID (step 3)
wrangler secret put SES_SECRET_ACCESS_KEY   # paste the AWS Secret access key
wrangler secret put TURNSTILE_SECRET        # paste the Turnstile Secret key (step 4)
wrangler secret put API_KEY                 # a long random password (for app-to-app sends)
```
Need a random `API_KEY`? Run `openssl rand -hex 32` and paste the result.

### 8) Deploy 🚀
Use a clean checkout at `origin/main`, or a tag reachable from it. The deploy guard
fetches origin before setup and passes HEAD to Wrangler as `BUILD_COMMIT`.
```bash
export MAILSTACK_HEALTH_URL=https://mail.example.com/health
npm run deploy
```
Cloudflare gives you a URL like `https://mailstack.<your-name>.workers.dev`. Check it works:
```bash
curl https://mailstack.<your-name>.workers.dev/health
# → {"ok":true,"service":"mailstack","version":"1.0.0","commit":"<HEAD sha>"}
```
The command fails if the deployed commit differs from HEAD. With no exported
`MAILSTACK_HEALTH_URL`, it explicitly reports that verification was skipped.
That's your live email service.

### 9) Connect your website form
Add the spam widget and point the form at mailstack. A minimal example:
```html
<form id="contact">
  <input name="name" required placeholder="Your name">
  <input name="email" type="email" required placeholder="Your email">
  <textarea name="message" required placeholder="Message"></textarea>

  <!-- Cloudflare Turnstile spam check (use your Site key) -->
  <div class="cf-turnstile" data-sitekey="YOUR_TURNSTILE_SITE_KEY"></div>
  <button>Send</button>
</form>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<script>
  document.getElementById("contact").addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    data.brand = "acme"; // your brand id from step 6
    data["cf-turnstile-response"] = e.target.querySelector("[name=cf-turnstile-response]").value;
    const res = await fetch("https://mailstack.<your-name>.workers.dev/v1/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    alert((await res.json()).success ? "Sent — thank you!" : "Something went wrong.");
  });
</script>
```
Submissions now arrive in your inbox. 🎉

---

## Public forms using ALTCHA

Brands may set `captcha: "altcha"` instead of using Turnstile. Set the Worker's
`ALTCHA_HMAC_KEY` secret and configure the widget's challenge URL as
`https://mail.example.com/altcha/challenge?brand=demo`. Send its base64 solution in
the `altcha` field of `POST /v1/send`.

Each challenge has a signed expiry of 10 minutes. A solution without a valid expiry,
an expired solution, or an already recorded solution returns `403 verification failed`.
The Worker atomically records usage in D1 before sending; missing storage or storage
errors also return 403. Fetch a new challenge for each submission or retry, including
after `send failed`. Records expire at the signed expiry; concurrent submissions of
one solution allow only one submission to proceed. Trusted sends skip guards.
The D1 rate limiter allows 8 attempts per brand/IP/hour and degrades open when storage
is missing or fails; public requests still require captcha. ALTCHA single-use recording
remains fail-closed: missing storage or storage errors return 403.

## Sending emails from your app (payments, welcome, etc.)

For server-to-server emails (no spam check needed), call the same endpoint with your `API_KEY`
and pick a template:
```bash
curl -X POST https://mailstack.<your-name>.workers.dev/v1/send \
  -H "content-type: application/json" \
  -H "authorization: Bearer YOUR_API_KEY" \
  -d '{
    "brand": "acme",
    "template": "payment",
    "to": "buyer@example.com",
    "name": "Jane Smith",
    "amount": "49.99", "currency": "USD", "item": "Pro Plan", "orderId": "ORD-1001"
  }'
```
Built-in templates: `payment`, `welcome`, `received`, `notice` (and `contact` for forms).

## What it costs
- **Cloudflare** (Workers, D1, Turnstile): generous free tiers — 100,000 Worker requests/day.
- **Amazon SES**: about **$0.10 per 1,000 emails** (often with a free monthly allowance). A
  contact form will almost certainly stay free.

## Updating it later
Change a setting (edit `.env` or `mailstack.json`) and run `npm run deploy` again. That's the
*entire* maintenance — there's no server to patch or keep running.

## Troubleshooting
- **Email not arriving?** You're probably still in SES "sandbox" — verify the recipient address
  (or request production access). Also check your spam folder.
- **"verification failed"?** The Turnstile widget wasn't solved, or your Site/Secret keys don't match.
- **"origin not allowed"?** Add your site's address to `allowedOrigins` in `mailstack.json`, redeploy.
- **"send failed"?** Your `from` address isn't verified in SES, or the SES region doesn't match
  where you verified it (the region is `SES_REGION` in `wrangler.template.toml`).

---

# Reference (for developers)

### Highlights
- **Multi-brand** — many tenants in one Worker; brand from `?brand=` or the request `Origin`.
- **Anti-relay** — the recipient is always the server-side `brand.to`; the request body can never redirect mail.
- **Two modes** — public (Turnstile + origin + honeypot + rate limit) and trusted (Bearer token).
- **Template types** — `contact`, `welcome`, `received`, `payment`, `notice`; one branded layout.
- **Footer branding** — change `MAILSTACK_HOME_URL` in `src/templates/layout.ts` to customize the mailstack link in HTML and plain-text emails.
- **Auto-reply** — optional confirmation to the submitter, sent non-blocking via `ctx.waitUntil`.
- **Sellf webhook adapter** — maps e-commerce events to branded emails (`/v1/hooks/sellf`).
- **D1 storage** — atomic rate limits and ALTCHA usage records. **Secret scanning** in pre-commit + CI.

### Config files
Nothing deployment-specific is committed. `npm run setup` (also run before `dev`/`deploy`)
generates these files. Test/typecheck hooks use the committed JSON example:

| Generated (gitignored) | From | Holds |
|---|---|---|
| `wrangler.toml` | `wrangler.template.toml` + `.env` | D1 ids + custom domain (`MAILSTACK_*` vars) |
| `src/core/config/bundled.ts` | external `MAILSTACK_CONFIG` JSON | Validated brands and logging policy + SHA-256 |
| `.wrangler/migrations/0001_initial.sql` | `src/core/store/migration.ts` | Shared schema for Wrangler D1 migrations |
| `src/assets/logo.ts` | `src/assets/logo.example.ts` | Brand logo PNG (base64) |

Configure via **`.env`** and the external **`MAILSTACK_CONFIG`** file; secrets via `wrangler secret put`. Full
deployment notes and architecture: see [AGENTS.md](AGENTS.md).

### Configuration commands

```bash
export MAILSTACK_CONFIG=/config/mailstack.json
npm run mailstack -- config check "$MAILSTACK_CONFIG"
node scripts/mailstack.ts config import-brands ./legacy/brands.ts > mailstack.json
node scripts/mailstack.ts client create --id acme-app --scopes send --brands acme --templates notice,payment
node scripts/mailstack.ts client create --id panel --scopes panel
```

`client create` prints the token once alongside its configuration entry containing `tokenSha256`.
Clients with `send` or `hook:sellf` require explicit `brands` and `templates` selections:
pass comma-separated lists or quote `'*'` for all values. The CLI requires both `--brands`
and `--templates` for these scopes. Panel-only clients may omit both; omitted selections
become empty lists. Legacy key defaults remain `brands: "*"` and `templates: "*"`.

The importer executes a trusted local TypeScript registry and writes JSON only to stdout.
Move its output outside the repository and set `MAILSTACK_CONFIG` before `npm run setup`.
`version`, `brands` (the previous Brand fields), and `logging` are required. `clients`,
`legacyApiKey`, `events`, and `alerts` are optional sections. Unknown keys in declared schemas
are errors, reported as JSON paths. Logging policies inherit global → brand → template;
retention ceilings and the resend/includeSecrets combinations are validated before startup.
`source` needs a matching client callback for each effective brand/template. The loaders
read classification from the template registry (`secretFields` is optional).
Enabling `includeSecrets` also requires a boot audit sink; the current Worker has none and
refuses that configuration until the audit store is integrated.

Node reads the file through `loadNodeConfig()`. Worker setup validates and bundles the external
file and sets `BUILD_CONFIG_SHA` in Wrangler vars. Its build step verifies that the source
still matches the bundle; rerun setup after editing the source. `npm test` and
`npm run typecheck` generate the committed example configuration locally, without reading
private brands. Run `npm run setup` again with your external config before a real build.
The JSON example and render snapshots contain only acme/demo data.

### API (summary)
- `GET /health` → `{ ok: true, service: "mailstack", version, commit }` (`commit: "dev"` locally).
- `POST /v1/send` — public (browser form, needs Turnstile) or trusted (Bearer token). Control
  keys: `brand` (required), `cf-turnstile-response`, `botcheck`, `subject`/`to`/`replyTo`/
  `template`/`autoreply` (trusted only). Everything else is email content.
- `POST /v1/hooks/sellf` — Sellf webhook adapter (Bearer required, optional client signature). See [AGENTS.md](AGENTS.md).
- `POST /v1/events/ses` — SNS subscription and SES delivery events. Returns
  `{ ok: true, result: "processed" | "duplicate" | "ignored" | "confirmed" }`.

### SES events

Configure `events.ses` with `topicArns` (SNS ARN list), `accountIds` (12-digit account list),
and optional `allowSignatureV1` (default `false`). SNS topics should use SignatureVersion 2.
The endpoint accepts bodies up to 256 KB. Invalid envelopes return 400, unverified messages
403, oversized bodies 413, and unavailable storage or evidence keys 503 so SNS can retry.
Set the JSON bindings `CONTENT_PUBLIC_KEYS` and `INDEX_KEYS` using the output of the keys CLI.

Events match existing messages through `ms_id` tags or account/provider identifiers and
recipients through blind indexes across active index keys. Event insertion and status
projection run atomically with SQLite transactions or D1 batches. Evidence contains the
complete SNS envelope sealed with purpose `evidence`; complaint events set the message's
`complained` flag. Unknown/deleted messages are acknowledged without creating rows.

Certificate parsing uses a small DER extractor for SPKI followed by WebCrypto RSA verification,
with no X.509 package dependency. Tests generate local RSA certificates and exercise both
Node and workerd. A real SNS notification remains a deployment validation step.

### Security model
Origin allow-list (CORS reflects the exact origin, never `*`) · server-side Turnstile (fails
closed) · honeypot · fixed recipient / anti-relay · D1 rate limit (8/hour per brand+IP) ·
constant-time bearer compare · all field values HTML-escaped · 64 KB / ~40 fields / 5000
chars-per-value guards · no secrets in code.

### Secret scanning
TruffleHog runs as a pre-commit hook (`.husky/pre-commit`, skips gracefully if not installed)
and in CI (`.github/workflows/secret-scan.yml`, always enforced). Install locally:
`brew install trufflehog`.

### Local development
```bash
cp .dev.vars.example .dev.vars   # fill in the secret values for local runs
npm run dev                       # wrangler dev
```

### Content and index keys
The standalone crypto helpers live in `src/core/crypto`; sending emails does not use them yet.
The CLI requires Node.js 22.18+ with native TypeScript support (verified on Node.js 26.12.1).

```bash
mkdir -m 700 secrets
npm run --silent keys -- init secrets/panel-content-keys.json
# Copy the two printed assignments into .env; the private JWK stays in the 0600 file.
# Load the existing INDEX_KEYS value into the environment before rotating:
npm run --silent keys -- rotate-index
# Replace INDEX_KEYS in .env with the printed assignment, including older keys.
```

`CONTENT_PUBLIC_KEYS` and the private file use JWK sets (`{"keys":[...]}`). `INDEX_KEYS`
is a JSON array of `{kid,key}`, where `key` is a base64url-encoded 32-byte key. In both
arrays the first entry is active; prepend new keys and retain older entries for reads.
Back up the private file separately from message data. Do not commit it or the environment values.

`seal(data, context, publicKeys)` and `open(value, context, privateKeys)` use a context
`{brand,messageId,purpose}` and the `ms1` envelope. Both accept an optional fourth
argument `maxBytes` (positive integer, default 2 MiB), measured in uncompressed UTF-8
JSON bytes. `seal` checks the size before compression; `open` counts decompressed
chunks and cancels the reader at the first chunk exceeding the limit. Exactly the
limit is accepted. `blindIndex(address,key)` returns
`{kid,index}`; `blindIndexes(address,keys)` returns one result for every active index key.
`canonicalJson` sorts object keys recursively in UTF-16 order, preserves array order,
and uses JSON primitive serialization; it rejects non-JSON values and cycles.
`createMac(data,keys)` returns `{kid,mac}` with a full base64url HMAC for request or
resend payloads; `verifyMac(data,tag,keys)` selects the matching key and returns a boolean.
HMAC inputs are UTF-8: `mailstack/v1/idx\n` followed by the normalized address for
blind indexes, or `mailstack/v1/mac\n` followed by canonical JSON for MACs (`\n` = LF).
Indexes retain the first 22 base64url characters; MACs retain the full digest.
Values computed without these context prefixes must be recomputed.

### Contributing & license
See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under **MIT** — see [LICENSE](LICENSE).

## Support

mailstack is free and MIT-licensed. If it's quietly delivering your emails right now,
you can buy me a croissant:

[![🥐 Buy me a croissant](https://img.shields.io/badge/🥐_Buy_me_a_croissant-FFDD00)](https://sellf.techskills.academy/checkout/tip-mailstack?utm_source=github&utm_medium=readme&utm_campaign=tip-jar)

## Send logging and idempotency

All outgoing mail, including public submissions and auto-replies, records an encrypted
intent before contacting SES. The effective `logging` policy comes from global, brand,
and template settings. `requireLog: true` returns `503` with `code: "log_unavailable"`
without sending if the intent cannot be recorded. With `requireLog: false`, delivery
continues without a log when storage or keys are unavailable. `level: "none"` writes no
message row and needs no encryption keys. Its separate 24-hour idempotency guard is
not implemented in this phase; deduplication currently requires a message row.

Trusted `POST /v1/send` requests accept:

| Input | Contract |
|---|---|
| `ref` | Optional string of 1-128 characters; otherwise `400 invalid_ref`. Stored encrypted with a correlation index. |
| `Idempotency-Key` header | Optional `[A-Za-z0-9._:-]{1,128}`; otherwise `400 invalid_idempotency_key`. |
| `resendOf`, `attachments` | Reserved for later phases; their presence returns `400 not_supported`. |

These keys are excluded from template content. Public requests ignore them and the
idempotency header. Trusted responses include `id: "msg_..."` whenever the send has a
message row; public response shapes are unchanged. Successful Sellf response shapes
are also unchanged. Provider failures retain `message: "send failed"`, with additive
`code: "send_failed"` and HTTP `502`.

Idempotency keys are scoped to the authenticated client (`legacy` for the legacy API
key; public sends use client id `public` without deduplication). For a matching request:

| Original state | Repeated request |
|---|---|
| `sent` or a later delivery state | `200 {success:true,id,idempotent:true}` without another send |
| `sending` | `409`, `code: "in_progress"` |
| `send_failed` (explicit provider refusal) | Clear the old key and execute a new attempt |
| `unknown` (exception, timeout, or uncertain result) | `409`, `code: "outcome_unknown"`; no automatic retry |
| Different request with the same key | `409`, `code: "idempotency_conflict"` |

An operator must resolve `unknown` through the panel or provider events before another
send is considered. The SES adapter makes one request per attempt. No idempotency key
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
Worker vars. For local `wrangler dev`, it may also be set in `.dev.vars`. Only sends
with a message row include `ConfigurationSetName` and tags `ms_id` (message id),
`ms_brand` (brand id). SES `MessageId` and the encrypted response body are recorded;
response headers are excluded. No open/click tracking configuration is sent.

### Retention and snapshots

The Worker runs retention hourly at minute 17 (UTC). Expired content, resend data
and guards are removed; message metadata and its children are deleted in atomic
batches of at most 500 messages. Logging ceilings also apply to existing rows.
Content readers must call `isContentReadable(row, now)` before returning content,
including when scheduled maintenance has not run yet. Sending rows older than
15 minutes become `unknown` with a local event; this does not resend mail.

`appendAudit(store, entry)` accepts internal metadata only: actors, actions,
message identifiers, counts and configuration identifiers; callers must exclude
personal data from targets and details. Details use canonical JSON. The first
`prev_hash` is 64 zeroes; absent target/details contribute empty strings to the
newline-separated SHA-256 input. Appends assign consecutive sequence numbers
inside an atomic write and retry a conflicting head at most three times.
Pruning removes a contiguous expired prefix only after recording
`audit.pruned {upTo, hashAtUpTo}`. `verifyChain(rows, anchor?)` checks ordered rows
and an optional independently stored `(seq, hash)` anchor. Supply the last known
head to detect a shortened tail; rows alone cannot establish a missing tail.
A pruned prefix can be checked from its marker or a matching boundary anchor.

Node exposes `backupSqlite(db, dir, now, keep=7)` for consistent daily snapshots
named `mailstack-YYYYMMDD.db` using UTC dates. It retains the seven newest matching
files and leaves other files untouched. Runtime scheduling is deferred to the
Node runtime integration; with daily scheduling, backups expire within seven
days. Keep keys outside the database and backup directory. Worker databases use
[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).
