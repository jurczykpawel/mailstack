[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/jurczykpawel/mailstack/actions/workflows/ci.yml/badge.svg)](https://github.com/jurczykpawel/mailstack/actions/workflows/ci.yml)

# mailstack

**Your own email-sending service — a free, self-hosted alternative to Web3Forms / Formspree.**

Put mailstack between your website's contact form (or your app) and your inbox. It catches the
submission, blocks spam, and sends you a clean, branded email. Run it on Cloudflare Workers with D1 and Amazon SES, or in Docker with Node, SQLite
and SES or SMTP. Each brand has its own sender, inbox, allowed origins and theme.

## Run with Docker (Node + SQLite)

Requires Docker Compose and Node 24+ for key generation. Prepare the local files once:

```bash
npm ci
cp config/mailstack.example.json mailstack.json
mkdir -p secrets
chmod 700 secrets
npm run --silent keys -- init secrets/panel-private.json > .env
chmod 600 .env
```

Keep `secrets/panel-private.json` separately from the data volume and its backups; the API
only needs the public key and index key printed into `.env`. Keys are never baked into the image.
Edit `mailstack.json` with your brand settings. Select the global sender with
`"sender": {"type": "smtp"}` or `"sender": {"type": "ses"}` (the default).
For trusted requests append a token assignment without printing it:

```bash
node -e 'console.log("API_KEY=" + require("node:crypto").randomBytes(32).toString("hex"))' >> .env
```

For SMTP append `SMTP_URL=smtps://user:password@smtp.example.com:465`, or use
`SMTP_HOST`, `SMTP_PORT` (default 587), `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE=true|false`
(default false). With credentials and `secure=false`, STARTTLS is required;
certificate verification remains enabled. Without credentials, STARTTLS remains opportunistic. URL credentials must be percent-encoded.
For SES set `SES_REGION`, `SES_ACCESS_KEY_ID` and `SES_SECRET_ACCESS_KEY` instead.
Public forms also need `TURNSTILE_SECRET` or `ALTCHA_HMAC_KEY` for their configured captcha.

Start the API with one command:

```bash
docker compose up --build -d --wait
```

The API is published on `127.0.0.1:8080` by default. For public traffic, put a reverse
proxy in front and configure `TRUSTED_PROXY` as described below, or deliberately set
`MAILSTACK_BIND=0.0.0.0` to publish on all host interfaces. `/health` reports `store: "ok"` after a database query;
`ok` remains true if storage goes down, while the container healthcheck reports unhealthy.
For diagnostics, `store: "ok"` proves database reads only, not writes or email delivery:
`requireLog: true` can return `503 log_unavailable` on read-only storage or a busy writer
while `/health` still returns `200` with `store: "ok"`. Check the send response and
storage permissions or write locks; after restoring writes, verify a controlled send.
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
docker compose -p mailstack-smtp -f docker-compose.yml -f docker-compose.test.yml up --build -d --wait
```

Mailpit is available at `http://localhost:8025`. Load the local token, then send twice
with the same idempotency key; the second response has `idempotent: true` and Mailpit
contains one message:

```bash
set -a
. ./.env
set +a
curl -sS http://127.0.0.1:8080/health
for attempt in 1 2; do
  curl -sS http://127.0.0.1:8080/v1/send \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $API_KEY" \
    -H 'Idempotency-Key: demo-smtp-1' \
    -d '{"brand":"acme","template":"notice","to":"buyer@example.com","heading":"Demo","paragraphs":"Hello"}'
done
```

Use a fresh idempotency key for each new logical message. A send records the final SMTP response and
queue identifier, with sealed evidence labelled `smtp-response`. This proves relay acceptance;
it does not prove delivery to the recipient. SMTP refusals become `send_failed`; network
exceptions become `unknown` and are never retried automatically. With multiple recipients,
partial acceptance remains a successful send and per-recipient events record refusals.
Remove the disposable test environment with
`docker compose -p mailstack-smtp -f docker-compose.yml -f docker-compose.test.yml down -v --rmi local`.

For Node without Docker (load `.env` into the environment first): `npm run build:node`, then `MAILSTACK_CONFIG=/path/to/mailstack.json npm start`.
The process needs a writable `/data` directory. Configuration is read and validated at startup;
invalid configuration stops the process before listening. The Node bundle includes no brand configuration.

## Releases

Pushing a `v*` release tag runs typecheck and tests, then builds the image for
`linux/amd64` and `linux/arm64`. CI smoke-tests the amd64 image with read-only example
configuration and SQLite on tmpfs; `/health` must report `ok: true` and `store: "ok"`
before the same OCI archive is published to `ghcr.io/jurczykpawel/mailstack`.
Tags are the version without `v` (for example `1.2.3`), `sha-<full-commit-sha>`, and
`latest` for stable `vMAJOR.MINOR.PATCH` releases only. Prereleases do not update `latest`.
OCI labels record the source, revision, release version and MIT license. Configuration
and secrets are supplied at runtime. The complete publication path will be verified
on the first release tag.

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

The Worker deployment runs on Cloudflare. The Docker deployment runs on your own server.

## What you'll need

The Worker path needs the following accounts; provider usage limits and charges apply.

| You need | What it's for | Cost |
|---|---|---|
| A **terminal** + **Node.js** (v24+) | to set up & deploy (copy-paste commands) | free |
| A free **Cloudflare** account | runs mailstack + the spam check | free |
| An **Amazon (AWS)** account | actually sends the emails (Amazon SES) | ~free at low volume |
| ~30–45 minutes, once | first-time setup | — |
| *(optional)* your own **domain** | a nicer URL + sending "from yourname.com" | — |

> **Not a developer?** You'll still open a terminal and paste a handful of commands — that's
> unavoidable for a self-hosted tool — but every step below is spelled out and explained.

---

## Worker setup — step by step

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
   a policy allowing **ses:SendEmail** for your verified sender identities → open the user → **Security credentials → Create access key**.
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
npx wrangler d1 create mailstack
npx wrangler d1 create mailstack-preview
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

After configuring brands in step 6, step 7 generates the SQL migration. Apply it
locally for development, or remotely before deployment.

### 6) Describe your "brand" (who the email is from and to)
Copy `config/mailstack.example.json` to a private location outside this repository, then
export `MAILSTACK_CONFIG` pointing to that file. Use Node 24 or newer (tested on Node 26).
Replace the `acme` entry under `brands` with the entry below (keep the surrounding
configuration and other brands):
```json
{
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
}
```
You can rename `acme` to anything (e.g. `mysite`). Remember that id — you'll use it when you
connect your form in step 9.

### 7) Prepare storage and runtime secrets
```bash
npm run setup                               # bundles MAILSTACK_CONFIG and prepares Wrangler config
npx wrangler d1 migrations apply DB --local   # development database
# Existing Worker databases: use npm run release (or npm run migrate:worker after setup)

npx wrangler secret put SES_ACCESS_KEY_ID       # paste the AWS Access key ID (step 3)
npx wrangler secret put SES_SECRET_ACCESS_KEY   # paste the AWS Secret access key
npx wrangler secret put TURNSTILE_SECRET        # paste the Turnstile Secret key (step 4)
npx wrangler secret put API_KEY                 # a long random password (for app-to-app sends)
npx wrangler secret put ALTCHA_HMAC_KEY         # needed for ALTCHA brands
npx wrangler secret put CONTENT_PUBLIC_KEYS     # JSON JWK set printed by npm run keys
npx wrangler secret put INDEX_KEYS              # JSON index-key array printed by npm run keys
npx wrangler secret put TRANSIT_KEYS            # JSON private transit-key set printed by npm run keys
```
Generate logging keys with `npm run keys -- init secrets/panel-private.json` after
creating a private `secrets` directory (see [keys](#content-and-index-keys)). **Mandatory:**
the tool prints nothing deployable until it has read and verified an offline copy of the
private file. Paste only the JSON values of the three assignments into the corresponding
Worker secrets; keep the private file separate. Local Worker development needs the same
JSON values in `.dev.vars` as well.

Need a random `API_KEY`? Run `openssl rand -hex 32` and paste the result.

### 8) Deploy 🚀
Use a clean checkout at `origin/main`, or a tag reachable from it. The deploy guard
fetches origin before setup and passes HEAD to Wrangler as `BUILD_COMMIT`. A Worker whose
`MAILSTACK_WORKER_NAME` is not `mailstack` (for example staging) may deploy a clean local HEAD
of any branch; its SHA is still reported in `/health`.
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

For a release that changes the schema use `npm run release` instead (same guard and health
check): it runs setup with `MAILSTACK_CONFIG` (and `MAILSTACK_PRO_PATH` when the configuration
uses Pro), refuses a migration set that misses core or Pro files or whose extension files differ
from those compiled for the configuration, applies the shared Node/Worker schema upgrade
through `npm run migrate:worker`, checks the migration files again and deploys the same set.
The upgrade runs before uploading the Worker, including on existing tables. It retains legacy
callback request keys, adopts existing extension columns, and records each extension version
with its schema changes. Pro's schema includes resend and SES tables with or without webhooks.
The generated SQL files remain available for inspection and fresh local databases; use the
shared upgrader for existing remote databases instead of applying those files separately. Do not run `npm test` or `npm run typecheck` between setup and deploy: they
regenerate the example bundle and remove Pro migrations, which the release then refuses.
That's your live email service.

Migration `0008_without_rowid.sql` (Node: the first start) rebuilds `messages`, `recipients`,
`subjects`, `guards` and `jobs` as `WITHOUT ROWID` tables, one written row less per insert.
It copies every row once in a single transaction; a failure leaves the old tables. Cost:
three to four written rows per copied row, one-off, counted against the daily D1 write limit.
Columns, keys and index names do not change, so rollback is a redeploy of the previous
version without schema steps.

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

For a public form with a product selection, a brand may opt into `requireNonce`:

```json
{ "captcha": "altcha", "requireNonce": true, "products": ["Demo Product"] }
```

`requireNonce` defaults to false when omitted. `products` is an optional array of
allowed product names, each 1-100 characters. Existing brands keep the flat challenge
response. For a brand with `requireNonce: true`, request
`GET /altcha/challenge?brand=demo&product=Demo%20Product` from an allowed origin.
An absent or unlisted product returns 400. The response is:

```json
{ "altcha": { "algorithm": "SHA-256", "challenge": "...", "maxnumber": 100000, "salt": "...", "signature": "..." }, "nonce": "..." }
```

Solve the nested `altcha` challenge and submit flat JSON to `POST /v1/send`:

```json
{ "brand": "demo", "email": "viewer@example.com", "src": "demo-video", "product": "Demo Product", "nonce": "...", "altcha": "<base64 solution>" }
```

The nonce uses `ALTCHA_HMAC_KEY`, is valid for 10 minutes, and carries the brand and
product. `product` in POST is optional; when present, it must match the nonce exactly.
The product must still be in the brand's configured list when submitting. Mailstack
sets `type` from that product, including for the confirmation email when auto-reply
is enabled. Only public requests for brands with `requireNonce: true` treat `nonce`
and `product` as control fields and omit them from email content. For other brands
and all trusted requests, both fields remain ordinary template content.

Mailstack atomically consumes the nonce before checking ALTCHA, including when ALTCHA
is invalid. Fetch a new challenge and nonce for every attempt, including after a failed
delivery. Nonce, ALTCHA and origin rejection returns `403 verification failed` for
these brands; missing or unavailable nonce storage returns 503. Rate limits still
return 429, and trusted sends skip nonce checks.

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
Built-in templates: `payment`, `refund`, `welcome`, `received`, `notice`, `license` (and `contact` for forms).
`license` accepts `name`, `productName`, `tier`, `domain`, `licenseKey`, `activationUrl`
and `instructions`; `licenseKey` and `activationUrl` are declared secret fields.

## What it costs
Cloudflare, SES, SMTP hosting and your server have separate usage limits and pricing.
Check your providers before deployment; mailstack itself is MIT-licensed.

## Updating it later
After editing the configuration, validate it with `npm run mailstack -- config check "$MAILSTACK_CONFIG"`.
Restart the Docker service with `docker compose up --build -d --force-recreate`, or use
the guarded Worker deploy from a clean release checkout. Keep runtime images and backups current; see [docs/backup.md](docs/backup.md) for encrypted offsite copies and restore.

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
- **Multi-brand** — many tenants in one Worker; send requests select `brand` from the body or query; preflight resolves `?brand=` or `Origin`.
- **Public recipient** — public mail goes to `brand.to`; the full API key may set `to` (scoped Pro clients need `recipientOverride: true`).
- **One full API key, free** — additional and restricted keys are a Mailstack Pro feature; see [API keys: free and Pro](#api-keys-free-and-pro).
- **Two modes** — public (Turnstile + origin + honeypot + rate limit) and trusted (Bearer token).
- **Template types** — `contact`, `welcome`, `received`, `payment`, `notice`, `license`; one branded layout.
- **Footer branding** — change `MAILSTACK_HOME_URL` in `src/templates/layout.ts` to customize the mailstack link in HTML and plain-text emails.
- **Auto-reply** — optional confirmation to the submitter, sent non-blocking via `ctx.waitUntil`.
- **Sellf webhook source** — maps e-commerce events to branded emails (`/v1/hooks/sellf`).
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

Configure via **`.env`** and the external **`MAILSTACK_CONFIG`** file; secrets via `npx wrangler secret put`. Full
deployment notes and architecture: see [AGENTS.md](AGENTS.md).

### Configuration commands

```bash
export MAILSTACK_CONFIG="$PWD/mailstack.json"
npm run mailstack -- config check "$MAILSTACK_CONFIG"
```

Scoped clients are created with the Mailstack Pro CLI (`node scripts/client.ts create` in
`mailstack-pro`); see [API keys: free and Pro](#api-keys-free-and-pro).

The importer executes a trusted local TypeScript registry and writes JSON only to stdout.
Move its output outside the repository and set `MAILSTACK_CONFIG` before `npm run setup`.
`version`, `brands` (the previous Brand fields), and `logging` are required. `clients`,
`legacyApiKey`, `events`, and `alerts` are optional sections. Unknown keys in declared schemas
are errors, reported as JSON paths. Logging policies inherit global → brand → template;
retention ceilings and the resend/includeSecrets combinations are validated before startup.
`source` needs a matching client callback for each effective brand/template. The loaders
read classification from the template registry (`secretFields` is optional).
Enabling `includeSecrets` also requires a boot audit sink. Both current runtime loaders
refuse it; keep it false. The optional `alerts` section is reserved and is not interpreted;
ntfy uses runtime variables and policy `alertOn`. `sender.type` selects `ses` or `smtp`
on Node; Worker sends through SES.

Node reads the file through `loadNodeConfig()`. Worker setup requires the config outside the repository, validates and bundles that
file and sets `BUILD_CONFIG_SHA` in Wrangler vars. Its build step verifies that the source
still matches the bundle; rerun setup after editing the source. `npm test` and
`npm run typecheck` generate the committed example configuration locally, without reading
private brands. Run `npm run setup` again with your external config before a real build.
The JSON example and render snapshots contain only acme/demo data.

### Complete configuration example

This is a complete `mailstack.json` for the local SMTP example. Copy it to the private
config file; replace the example sender/origins for deployment. For SES choose
`"sender": {"type": "ses"}` and supply SES credentials. The optional SES event
allowlist below is illustrative; replace both values before subscribing a real topic.

```json
{
  "version": 1,
  "sender": { "type": "smtp" },
  "brands": {
    "acme": {
      "id": "acme", "name": "Acme", "from": "Acme <hello@acme.example>",
      "to": ["inbox@acme.example"], "allowedOrigins": ["https://acme.example"],
      "subjectPrefix": "New message", "autoReply": false,
      "theme": { "accent": "#0064BC", "siteUrl": "https://acme.example" }
    }
  },
  "legacyApiKey": { "enabled": true, "attachments": true },
  "logging": {
    "defaults": {
      "level": "meta", "contentDays": 30, "metaDays": 90, "requireLog": true,
      "resend": "off", "alertOn": ["send_failed", "unknown"],
      "show": [], "includeSecrets": false
    },
    "ceilings": { "contentDays": 90, "metaDays": 400, "auditDays": 400 },
    "patterns": [{ "name": "url-parameters", "urlParams": ["token", "key", "code"] }],
    "brands": {
      "acme": { "templates": {
        "payment": { "level": "masked", "show": ["amount", "currency", "orderId"] },
        "license": { "level": "masked", "requireLog": true, "show": ["productName", "tier"] }
      } }
    }
  },
  "events": { "ses": {
    "topicArns": ["arn:aws:sns:eu-west-1:123456789012:mailstack-events"],
    "accountIds": ["123456789012"], "allowSignatureV1": false
  } }
}
```

The legacy key has attachment permission here solely for the local attachment example.

### API keys: free and Pro

The free core authenticates exactly one **full key**: the secret in `API_KEY` (or the
variable named by `legacyApiKey.env`). It has scopes `send` and `hook:sellf`, every brand
and template, and may override `to`. Free `legacyApiKey` options are `enabled`, `env`,
`attachments` and `signatureSecretEnv` (required `X-Sellf-Signature` on `/v1/hooks/sellf`,
see [Sellf webhook](#sellf-event-contract)). `scopes`, `brands`, `templates` and
`recipientOverride` may only restate the full values; any restriction fails validation with
`additional or restricted API keys require Mailstack Pro`.

Everything beyond that single key is Mailstack Pro (valid license):
additional `clients` with their own tokens, brand/template/scope restrictions,
`recipientOverride: false`, `rate`, `resendCallback`, and the `panel` client. Pro registers
a key provider through the extension `keys` hook; the core asks it only about tokens other
than the full key. Without a license Pro rejects those tokens with 401 while the full key
keeps sending. A configuration containing `clients` stops startup when no loaded extension
provides keys (`$.clients: additional or restricted API keys require Mailstack Pro`).
The Worker loads no extensions: without `MAILSTACK_PRO_PATH`, `npm run setup` rejects `clients`
and only the full key works there. With `MAILSTACK_PRO_PATH=/abs/path/mailstack-pro` in `.env`,
setup validates `clients` and the `mailstack-pro` extension options through Pro, generates the
gitignored `src/core/pro.generated.ts` and migration `0003_pro_license_cache.sql` (license cache in
D1). Set the license with `wrangler secret put MAILSTACK_LICENSE`; options are `product`, `host`,
`seller`, `jwksUrl` and `revocationUrl` (no `cachePath`, `webhooks` or `aws`). A stale cache is
refreshed after the response; scoped keys keep working for seven days without the issuer.
`npm run deploy` and `npm run release` then also require a clean Pro checkout at its `origin/main` (or a reachable tag; any clean branch for a non-production Worker)
and reports it as `proCommit` in `/health`.

### Migrating a legacy brand registry

The input must export JSON-compatible `BRANDS`; the importer executes trusted local
TypeScript in a child Node process with the same permissions and environment. This
is not a sandbox. Standard output and error from the module (including
`console.log`, `process.stdout.write` and deferred diagnostics) go to CLI stderr;
stdout contains only the validated configuration JSON on success. Import, export
serialization or validation failures return a nonzero exit code with empty stdout.
The registry transfer is limited to 1 MiB; modules must finish their pending work
before the command returns. From
the repository root, with your old registry saved as `legacy/brands.ts`:

```bash
node scripts/mailstack.ts config import-brands ./legacy/brands.ts > mailstack.json
node scripts/mailstack.ts config check ./mailstack.json
export MAILSTACK_CONFIG="$PWD/mailstack.json"
```

The importer preserves the registry and adds the example logging defaults. Review
clients, captcha settings and per-template policies, then move the file to your private
configuration location and update `MAILSTACK_CONFIG`. Node loads it on restart; Worker
needs `npm run setup` and a build/deploy. Do not restore `src/brands.ts` or edit generated
bundles. Keep credentials in runtime secrets, outside this JSON.

### API (summary)
- `GET /health` → `{ ok: true, service: "mailstack", version, commit }` (`commit: "dev"` locally).
  This is liveness, not readiness; its `store: "ok"` field proves reads, not writes or
  delivery, and read-only storage can still cause `requireLog: true` sends to return `503`.
- `POST /v1/send` — public (browser form, needs Turnstile) or trusted (Bearer token). Control
  keys: `brand` (body or query), `cf-turnstile-response`, `botcheck`, `subject`/`to`/`replyTo`/
  `template` (trusted only), `autoreply` (public contact), plus the reserved fields documented below.
  Empty or omitted body `brand` falls back to `?brand=<id>`; different nonempty values return `400 brand mismatch`.
  Public requests may use ALTCHA instead of Turnstile; opted-in brands also require a nonce.
- `POST /v1/hooks/sellf` — Sellf webhook source (Bearer required, optional client signature). See [AGENTS.md](AGENTS.md).

- `POST /v1/events/ses` — SNS subscription and SES delivery events. Returns
  `{ ok: true, result: "processed" | "duplicate" | "ignored" | "confirmed" }`.

When upgrading an existing configuration, add `refund` alongside `payment`,
`notice` and `welcome` in the Sellf hook client's `templates` list. Otherwise
`refund.issued` returns `403` with code `scope`. A `"*"` selection already includes it.

### Purchase licenses and activation

The first `purchase.completed` payment email includes every supplied `licenses[]`
entry, each with its full key in a separate code box and in plain text. Names come
from `product` and `bundleComponents` by product ID; an unknown ID is displayed
explicitly. Bump products do not implicitly receive licenses. Missing or empty
`licenses` means an ordinary payment email. Invalid entries, repeated product IDs,
more than 32 entries, or more than 48 KiB of serialized license data return
`422 invalid_event_data` before recording or sending. The hook body remains capped
at 64 KiB. Keys are never silently shortened, including when their total exceeds
5000 characters. License dates are not derived from tokens.

The owner may configure `licenseActivationUrls` on each brand as a product-ID to
HTTP(S)-URL map. Omission is equivalent to an empty map. Use exact, owner-managed
product settings pages, with no license tokens in their URLs:

```json
"licenseActivationUrls": {
  "bundle": "https://source.test.example/activate/bundle",
  "component": "https://source.test.example/activate/component"
}
```

The example `acme` brand demonstrates both routes; `demo` has an empty map. Replace
these synthetic routes in your external config with your own product settings
pages. The email tells the buyer to paste each key into the matching product's
license settings and activate each component separately. Without a configured
page, it gives the same complete instructions and the brand inbox for help,
without an activation button. JWKS, CRL, custom domains and token contents never
supply activation links. Configured activation URLs and individual keys use the
payment template's optional secret fields in standard archives. Existing payment
`resend: "replay"` policies remain valid for ordinary payments. When a purchase
contains a key or activation URL, core stores no replay payload or replay MAC and
disables replay for that message. Use `off` or an explicitly supported source
callback for those purchases.

Purchase order IDs, correlation refs and automatic deduplication prefer the saved
`order.orderId`, then PI, then CS. At an upgrade, coordinate pending producer retries
over the 24-hour deduplication window: a previous PI/CS-keyed purchase and a new
UUID-keyed retry can be distinct sends. No historical
jobs are guessed or migrated. Refund identifiers are unchanged by this rule.

For local review, generate synthetic first-email fixtures with
`node test/generate-purchase-license-fixtures.ts <output-directory>` and serve that
directory locally. The index provides configured/unconfigured emails and full
expected keys for copy checks at 390 and 1440 px. The isolated test fixture serves
`https://source.test.example/activate/bundle` and `/activate/component`, where a
buyer can paste the complete synthetic key and confirm the matching product.
These pages are explicitly demonstrations, with no provider activation. Browser
review and real provider integration are separate checks.

### Configurable webhook sources

`POST /v1/hooks/<id>` selects `sources.<id>` from `mailstack.json`. Omitting
`sources` installs the built-in Sellf preset; an explicit object replaces the source
registry (`{}` disables all sources). The example configuration includes Sellf.
Copy [docs/sources/sellf.json](docs/sources/sellf.json) under `sources.sellf` to
customize it, for example:

```json
{"sources":{"sellf":{"signature":{"scheme":"t-v1","header":"X-Sellf-Signature","toleranceSeconds":300},"envelope":{"event":"event","timestamp":"timestamp","data":"data"},"events":{"waitlist.signup":{"action":"send","template":"notice","to":"data.customer.email","fields":{"heading":{"format":"Waitlist"},"paragraphs":{"format":"Thanks for joining {data.product.name}."}}}}}}}
```

Each send map declares a template, recipient path, fields, optional `ref` and
`idempotencyKey` selections. Startup rejects unknown templates, invalid paths and
maps missing required template fields or action `requiredFields`. `ignore` acknowledges without sending;
`reject` returns `422 unsupported_event`; unlisted events are ignored.
Bearer plus `hook:<id>` scope and brand/template permissions are always required.
Signatures support `t-v1`, `sha256-prefix` and `bearer-only`; signing is additional
when the key names a runtime secret (`legacyApiKey.signatureSecretEnv` for the full key's
`hook:sellf`, or a Pro client's reference). Configure no signing reference for
`bearer-only`. Source definitions contain secret references only through keys.

Fields use plain dotted paths (including numeric indices), `{"join":["path"]}`,
`{"first":["preferred.path","fallback.path"]}` (first nonblank scalar),
`{"format":"Text {data.product.name}"}` (path placeholders only), or
`{"path":"data.order.amount","as":"money-minor"}`. Other closed transforms are
`upper`, `date-pl` (runtime timezone) and `map` with typed lookup keys:
`{"path":"data.refund.isFullRefund","as":"map","map":{"boolean:true":"true","boolean:false":"false"}}`.
Map keys must use `boolean:true`, `boolean:false`, `number:<String(value)>` or
`string:<exact value>` (including `string:` for an empty string). Thus boolean
`true`, number `1` and strings `"true"`/`"1"` are distinct; untyped keys must be
migrated before startup: replace an old `"true"` key with `"boolean:true"` for a
boolean input or `"string:true"` for text; replace `"1"` with `"number:1"` for a
number or `"string:1"` for text. To accept both types, declare both keys explicitly.
There is no automatic type inference or migration; update custom preset copies too.
Missing, null, structured, nonfinite and unmatched values map to empty.
Numbers use JavaScript's canonical string representation; `-0` and `0` share `number:0`.
Minor units use division by 100 and `toFixed(2)`, preserving the former Sellf
adapter's rounding, including near the safe integer limit. `ref` and
`idempotencyKey` accept a path, `first` or `join`. No expressions or executable code are
accepted. General limits: 64 KiB body, depth 20, 40 mapped fields, 5000 characters
per value. An action may add `requiredFields` naming nonblank mapped keys.
`transform: "purchase-licenses"` is a built-in Sellf transform:
it calls the existing license formatter on envelope data after validation. Its
output uses the existing license limits rather than general field/count limits.
`sellf-license` selects the license mail source and owner-configured activation page;
`free-access` acknowledges non-free access without sending. Other custom behavior
belongs in an operator-installed runtime extension.

### Sellf event contract

The hook requires an object envelope with a nonblank string `event`, a valid ISO
8601 `timestamp` including a timezone, and a non-null, non-array object `data`.
Malformed JSON returns `400 invalid JSON`; a malformed envelope returns
`400` with `code: "invalid_envelope"`. Authentication, configured HMAC, scope and
64 KiB body limits apply before delivery. Extra custom fields are allowed.

Mailstack checks sender authentication, the recipient address and nonblank mapped
`requiredFields` declared by the selected template and source action. It does **not** validate the
sender's business rules: refund status, cumulative totals, full/partial consistency,
nonnegative amounts, three-letter currencies or matching currencies. Sellf must
validate those before sending. Scalar field values become strings; objects and
missing values become empty. Amount transforms require safe integer minor units
and produce two decimal places with a dot (`4999` -> `49.99`).
Missing required output returns `422 invalid_event_data`, with template keys such
as `amount` (recipient errors use `data.customer.email`), never submitted values.
Validation follows mapping and precedes storage, deduplication and provider calls.

| Event | Outcome and template requirements beyond a valid customer email |
|---|---|
| `purchase.completed` | `payment`: nonblank amount, currency, item and orderId. Saved order UUID preferred, then PI, then CS. `settledVia=bank_transfer` renders “Płatność otrzymana”. Optional `licenses` retain the existing 32-entry/48 KiB validation and configured activation URLs. |
| `refund.issued` | `refund`: amount, currency, productName, transactionId (PI preferred, CS fallback), paymentId, refundId, isFullRefund, totalRefunded and refundedAt. Only boolean isFullRefund maps to a scope: true means pełny, false means częściowy. Missing/null/text (including "true") maps to empty and returns 422 invalid_event_data with field isFullRefund before recording or sending; no scope is guessed. Status is not inspected; the template describes a completed refund. Send only completed refunds. |
| `waitlist.signup` | Signup notice with configured heading and paragraphs; product name is optional interpolation. |
| `lead.captured` | Welcome email with access intro; no required template fields. |
| `access.expired` | Expiry notice with configured heading and paragraphs; product name is optional interpolation. |
| `order.placed` / `order.payment_reminder` | `bank-transfer`: orderId, transfer holder/account/bank/title, amount, currency, paymentDeadline and payUrl are required. Identity/ref: saved orderId, separate namespace per event. |
| `order.cancelled` | `notice`: orderId and cancelReason required; optional cancelReasonText is displayed. Identity/ref: orderId. |
| `order.participants_needed` | `notice`: orderId, product.name, numeric reminder.stage (1: after 24 h, 2: two days before the event), participantsUrl required. Identity: orderId + stage; ref: orderId. |
| `access.granted` | `welcome` only for grantSource=free; access.id, product.name and a recognized grantSource required. Other sources are acknowledged without mail. Identity/ref: access.id. This is product access, not an authentication link. |
| `license.issued` | `license`: license.id/order/issuanceSource, product.id/name and licenseKey required. Identity: license.id; ref: license.orderId, order, then id. Paid purchase keys follow the precedence below. |
| `subscription.created` | `422 unsupported_event` |
| `subscription.updated` | `422 unsupported_event` |
| `subscription.canceled` | `422 unsupported_event` |
| `subscription.trial_ending` | `422 unsupported_event` |
| `subscription.renewal_upcoming` | `422 unsupported_event` |
| `invoice.paid` | `422 unsupported_event`; source `invoice.amountPaid` is in major units. `subscription` contains only `stripeSubscriptionId`, without status or paid period. |
| `invoice.payment_failed` | `422 unsupported_event`; source invoice amounts are in major units. |
| `license.revoked` | `422 unsupported_event`; source recipient is `license.email`, with `license.id`, `order`, `revokedAt` and nullable/optional expiry. No token is included. |
| Any other event | `200 {success:true,ignored:"<event>"}` after envelope validation; no email or message id. |

Paid purchase keys have one mail source: with `purchase.completed` configured with
`transform: "purchase-licenses"`, `sellf-license` acknowledges purchased
`license.issued` without another email. Free order claims (`license.order` beginning
with `free_`), manual and API issuance use the `license` template, deduplicated by
`license.id`. This decision is independent of arrival order and makes no storage
query. Keep `purchase.completed` subscribed and permitted for the same brand when
using this preset. To deliver all keys through `license.issued` instead, remove
`purchase-licenses` from the purchase action: payment emails then contain no keys.
The standalone license mail uses only the brand's `licenseActivationUrls` for its
product; `licenseKey` and activation URLs are secret fields.

Participant and transfer links are delivery credentials. They are secret fields in
the respective templates and cannot be replayed from stored message content.
`lead.captured` remains a separate welcome notification: subscribe to it or to
free `access.granted` according to the desired flow; enabling both sends both.

Omitting `sources` installs the updated preset. If your external configuration has
an explicit `sources.sellf`, copy the updated mappings from
`docs/sources/sellf.json` and validate the configuration before release.

For the Sellf webhook endpoint, select **only events supported by Mailstack** in
Sellf's sender settings (see the table above). For purchase and refund emails,
select only `purchase.completed` and `refund.issued`; enable other supported events
only when needed. Leave the known unsupported events unchecked: Mailstack returns
`422 unsupported_event`, which Sellf treats as a retryable error (observed retries,
up to five attempts). The hook continues to return 422 for these events.

Known unsupported events return `{success:false,code:"unsupported_event",message:...}`
with the event name for both complete and incomplete `data` objects. This is a
permanent configuration error: disable those events in the sender; retry alone
will not help. This does not declare implemented renewal or revocation support.
The source Stripe dispute path emits only `license.revoked` for licenses actually
revoked. With no license rows there is no notification. Its payload has no dispute
reason/status, so it cannot establish a complete chargeback notification contract.
No subscription periods or revocation tokens are invented by the adapter.

The hook awaits `renderAndSend` and returns its trusted delivery response for both
success and failure. With a message row, first success is
`200 {success:true,id:"msg_..."}`; duplicates return the same id plus
`idempotent:true`, without another send. With logging level `none`, there is no id;
a retained reservation still returns `idempotent:true` on duplicate. Public `/send`
responses keep their existing shape.

After losing an ACK, retry the identical event: a completed logged attempt returns
its original id and `idempotent:true`. A concurrent logged attempt returns
`409 in_progress`; wait and retry the same event. `409 outcome_unknown` requires
provider reconciliation, and `409 idempotency_conflict` requires resolving the
changed request; do not send again under a new key. `502 send_failed` after explicit
provider refusal permits retry of the same event after the provider issue is fixed.
An exception/timeout can instead leave an unknown outcome. `503 log_unavailable`
means required intent recording failed without sending: restore logging and retry
the same event. Fix 400/401/403/413/422 input/configuration errors before retrying.
SMTP success means relay acceptance, not final delivery. These guarantees require
available storage and follow the shared logging/idempotency policy below.

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

Extensions can read operational status through `ctx.sesStatus()` (contract
`SesStatusV1`, `version: 1`). It is available only in authenticated internal Node
extension routes whose panel client selects both brands and templates as `"*"`;
viewer, operator and admin assertions are accepted without step-up. It is absent
from event/deletion hooks and scoped panel routes. For example:

```ts
app.route('GET', '/ses-status', async (_request, ctx) => {
  if (!ctx.sesStatus) return new Response(null, { status: 403 });
  return Response.json(await ctx.sesStatus(), { headers: { 'cache-control': 'no-store' } });
});
```

The snapshot contains `configured`, `region` (runtime `SES_REGION`), configured
`topicArns`/`accountIds`, and `subscriptions: [{topicArn, confirmedAt}]`.
`confirmedAt` is epoch milliseconds of the latest successful local confirmation,
not an AWS subscription lookup; null means none observed since this migration.
It also contains `received`, `rejected: {signature, topic, account}`,
`lastReceivedAt` and `lastReceivedType` (null until first observation).
Counters count structurally valid SNS envelopes, including retries and ignored or
unmatched notifications, independently of message logging. Rejection categories
are exclusive: topic first, then account, then signature/verification failure.
Malformed/oversized bodies are excluded. The last type is a recognized SES event
name for verified, valid SES payloads; otherwise it is the SNS envelope type.
Times use local receipt time, never the supplied event timestamp, and do not move
backwards. No addresses, message ids, tokens, content or raw envelopes are included.

Observations are aggregate, retained with the database across restarts and message
retention, and shared by SQLite and D1; apply the generated
`0002_ses_status.sql` D1 migration to existing installations. Old events are not
backfilled. Observation writes are best-effort and do not change endpoint results;
storage outages can leave gaps. Reads reject on storage failure, rather than
reporting zero. Confirmation is recorded only after the confirmation request and
audit succeed. `configured: false` reports empty configuration selections but
preserves historical counters. This adds no public endpoint or `DomainEvent` type.

To connect SES and SNS:

1. In the same AWS region as SES, create an SNS topic with signature version 2 and
   allow SES to publish events to it. Put its exact ARN and account id in `events.ses`.
2. Create an SES configuration set and an enabled SNS event destination for `SEND`,
   `REJECT`, `BOUNCE`, `COMPLAINT`, `DELIVERY`, `DELIVERY_DELAY`, `RENDERING_FAILURE`.
   Leave open/click tracking disabled.
3. Set `SES_CONFIGURATION_SET` to that set's name. On Worker, run setup and redeploy
   with the updated config and keys; on Node, restart with the updated environment.
4. Subscribe the public HTTPS URL `https://mail.example.com/v1/events/ses` to the
   topic. Use the standard SNS envelope, without raw message delivery. The handler
   confirms an accepted subscription automatically; check the subscription is confirmed.
5. Send a logged test message and inspect delivery events in the store. Only messages
   with a message row receive the configuration set and `ms_id`/`ms_brand` tags.

No AWS resources are created by mailstack. Certificate/signature handling is tested
locally on Node and workerd; a real SNS notification is a separate deployment check.
SMTP records relay acceptance locally and does not consume SES delivery events.
SMTP DSN polling and generic provider webhooks are not implemented.

### Security model
Origin allow-list (CORS reflects the exact origin, never `*`) · server-side Turnstile (fails
closed) · honeypot · fixed recipient / anti-relay · D1 rate limit (8/hour per brand+IP) ·
constant-time bearer compare · all field values HTML-escaped · 64 KiB (10 MiB for attachment-enabled send clients) / ~40 fields / 5000
UTF-16 code units per content value · no secrets in code. Content values are capped
after string-array joining (with blank-line separators). If the boundary falls
inside a surrogate pair, the whole final character is omitted, leaving 4999 units.
The request body byte limits remain 64 KiB / 10 MiB.

### Secret scanning
TruffleHog runs as a pre-commit hook (`.husky/pre-commit`, skips gracefully if not installed)
and in CI (`.github/workflows/secret-scan.yml`, always enforced). Install locally:
`brew install trufflehog`.

### Local development
```bash
cp .dev.vars.example .dev.vars   # fill runtime secrets, including logging key JSON values
npm run dev                       # npx wrangler dev
```

### Content and index keys
The send pipeline uses `src/core/crypto` to seal recipients, subjects, refs, archive projections,
provider responses and event evidence. The CLI requires Node.js 24+.

```bash
mkdir -p secrets
chmod 700 secrets
npm run --silent keys -- init secrets/panel-content-keys.json
# Copy the file to offline storage (USB drive, password manager attachment), then
# type the path of that copy at the prompt. Without a terminal, run instead:
npm run --silent keys -- init secrets/panel-content-keys.json --backup-verified /Volumes/OFFLINE/panel-content-keys.json
# Copy the three printed assignments into .env; the private JWK stays in the 0600 file.
# Load the existing assignments from the private .env before rotating:
set -a
. ./.env
set +a
npm run --silent keys -- rotate-index
# Replace INDEX_KEYS in .env with the printed assignment, including older keys.
```

**Offline copy (mandatory step).** The private file is the only key that opens archived
content; no server holds it. If every copy is lost, the content of the whole history is
permanently unreadable; nobody, including the maintainers, can recover it. `init` therefore
writes the private file and then requires the path of a separate offline copy. It reads
the copy, compares its keyring fingerprint with the private file and opens a test value
sealed to every public key. A missing, corrupted or different copy, or the private file
itself, exits with a nonzero code and prints no keys to deploy. On success stderr shows
the keyring fingerprint (`xxxx-xxxx-…`, `keyringFingerprint` in `src/core/keyring.ts`,
also used when the panel imports a keyring). Rerunning `init <file> --backup-verified <copy>` on an existing
file prints the same public keys with new index and transit keys, so use it only before
the first deployment.

`TRANSIT_KEYS` is a private X25519 JWK set (`{"keys":[...]}`) for the browser-to-API
transit envelope. It is an API secret only; the API publishes its public part. It does
not open archived content.

`CONTENT_PUBLIC_KEYS` and the private file use JWK sets (`{"keys":[...]}`). `INDEX_KEYS`
is a JSON array of `{kid,key}`, where `key` is a base64url-encoded 32-byte key. In both
arrays the first entry is active; prepend new keys and retain older entries for reads.
`init` refuses to overwrite its private-key file. For content-key rotation, generate a
new pair at a new filename, prepend its public JWK, and retain both private files.
Keep old keys through the metadata retention ceiling and any retained backups.
`rotate-index` prints a replacement assignment; it does not update `.env` itself.
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

## Send logging and idempotency

All outgoing mail, including public submissions and auto-replies, uses the logging
pipeline before contacting the configured provider. The effective `logging` policy
comes from global, brand, and template settings. `requireLog: true` returns `503` with `code: "log_unavailable"`
without sending if the intent cannot be recorded. With `requireLog: false`, delivery
continues without a log when storage or keys are unavailable. `level: "none"` writes no
message row and needs no encryption keys. With an idempotency key, it stores only a
client-scoped hash in `guards`, expiring after 24 hours. Missing or unavailable storage
allows delivery without deduplication, even with `requireLog: true` at level `none`.

### Logging policies

Policies resolve from `logging.defaults` through `logging.brands.<id>.defaults` to
`logging.brands.<id>.templates.<template>`. Requests cannot override them.

| Level | Stored |
|---|---|
| `none` | No message row, recipients, content or delivery events; short-lived guards only |
| `meta` | Message metadata, sealed recipients/Reply-To, subject, ref and provider response; events and sealed evidence |
| `masked` | `meta` plus a sealed archive projection keeping template defaults or content fields explicitly listed in `show`; other fields become `[ukryte]` |
| `full` | `meta` plus the archive rendering; declared secret fields and configured patterns remain masked |

Templates declare `maskedFields` as the default visible content keys when `show`
is omitted at every policy layer. An explicit `show` at the most specific configured
layer replaces the entire list (including `show: []` to hide all content fields).
To extend a default list, copy its keys and add your own; to narrow it, list only the
keys you want. Existing configurations with explicit `show` keep their behavior.
The example configuration omits `show` so staging compositions inherit these defaults:

| Template | Default visible fields |
|---|---|
| `bank-transfer` | `orderId`, `amount`, `currency`, `deadline` |
| `payment` | `amount`, `currency`, `item`, `description`, `orderId`, `date` |
| `refund` | `amount`, `currency`, `productName`, `transactionId`, `paymentId`, `refundId`, `isFullRefund`, `totalRefunded`, `refundedAt` |
| `license` | `productName`, `tier` |
| `notice`, `welcome` | None; arbitrary message text may contain personal data or tokens |

Recipient names/addresses, license keys, activation links, other URLs and tokens
are never included in these defaults. Declared secret fields remain masked even
when listed in `show`. A hidden or unrecognized refund scope omits the scope line;
only boolean `true`/`false` and strings `"true"`/`"false"` select full/partial refunds.

`secretFields` is declared by templates in code; the `license` template declares
`licenseKey` and `activationUrl`. Secret values in archive projections show only their
last four characters when longer than four; shorter secrets are fully hidden.
The `payment` template declares each purchase key and configured activation URL
separately in `optionalSecretFields`; these have the same archive projection rules
and disable replay only when present in the message. `patterns` supports named
`regex` or `urlParams` rules. Archive projections omit JSON-LD; outgoing email keeps the original rendering. `subjectRoles`
identifies submitter address fields for data-subject indexing (`contact.email`).

Retention values are positive integer days; `contentDays <= metaDays`, and both must
fit the global ceilings. `requireLog` controls whether a missing intent prevents delivery.
`resend: "replay"` validates only with `masked`/`full` and templates without
unconditional secret fields; `source` needs a matching `send` client with `resendCallback`. Defaults remain
`resend: "off"`; execution requires an extension declaring the resend capability. `includeSecrets` requires `full` and a boot audit sink; current runtimes require false.

Trusted `POST /v1/send` requests accept:

| Input | Contract |
|---|---|
| `ref` | Optional string of 1-128 characters; otherwise `400 invalid_ref`. Stored encrypted with a correlation index. |
| `Idempotency-Key` header | Optional `[A-Za-z0-9._:-]{1,128}`; otherwise `400 invalid_idempotency_key`. |
| `resendOf` | Requires an enabled extension and an approved source job, its owning client and matching `Idempotency-Key`; otherwise `400 not_supported` without the extension or `409 resend_mismatch`. |
| `attachments` | Array of `{ filename, contentType, contentBase64 }`; requires `attachments: true` on a trusted client. |

These keys are excluded from template content. Public requests ignore them and the
idempotency header. Trusted responses include `id: "msg_..."` whenever the send has a
message row; public response shapes are unchanged. Sellf hook responses use the
same trusted delivery contract, including `id` and `idempotent` when applicable. Provider failures retain `message: "send failed"`, with additive
`code: "send_failed"` and HTTP `502`.

Idempotency keys are scoped to the authenticated client (`legacy` for the legacy API
key; public sends use client id `public` without deduplication). All logging levels
share one atomic reservation in `guards`, lasting 24 hours from the first attempt.
Changing a logging policy or restarting the runtime preserves that reservation.
Existing unexpired `none` guards and `meta`/`masked`/`full` message records are recognized
without a backfill or access to plaintext keys. If an old unlogged reservation coexists
with a refused message, it remains reserved until expiry. Recorded reservations use
`guards.count = 2`; unlogged and legacy reservations use `1`, so clearing a refused
message's binding cannot release an older unlogged reservation.
Changing policy never removes message evidence.
At the 24-hour boundary, a new attempt may claim the key without waiting for retention;
only the expired key binding is cleared from old messages, leaving their evidence intact.

With the current policy at `none`, a repeated key without a message record returns
`200 {success:true,idempotent:true}` without an `id` or another send, including while
the original attempt is pending or its outcome is uncertain. Without a request MAC,
a different body cannot be distinguished.
At `meta`, `masked` or `full`, a reserved key without a message record is read again
up to three times, 10 ms apart, then returns `409 in_progress` if still absent.
This also applies after switching from `none` to a logged level: the original
reservation remains in force until expiry, without another send or a success without ID.
An explicit provider refusal releases an unlogged reservation for retry; preparation
errors leave the key available. Missing or unavailable storage at `none` still allows
sending without deduplication, regardless of `requireLog`.

When the original attempt has a message record, its request MAC and state determine
the response below, even if the current policy is `none`. A missing or unverifiable
MAC returns `409 idempotency_conflict` without sending. Reservation hashes do not depend
on index keys. Keep previous index keys during rotation to verify recorded request MACs;
removing a required key returns a conflict until the 24-hour reservation expires.
An explicit refusal permits a matching request to retry under the current policy.

| Original state | Repeated request |
|---|---|
| `sent` or a later delivery state | `200 {success:true,id,idempotent:true}` without another send |
| `sending` | `409`, `code: "in_progress"` |
| `send_failed` (explicit provider refusal) | Clear the old key and execute a new attempt |
| `unknown` (exception, timeout, or uncertain result) | `409`, `code: "outcome_unknown"`; no automatic retry |
| Different request with the same key | `409`, `code: "idempotency_conflict"` |

An exception or timeout marks unresolved recipients `unknown` along with the message.
Retention applies the same update to `sending` attempts older than 15 minutes, including
after restart. Known recipient outcomes, partial SMTP relay acceptance/refusal and the
message complaint flag remain intact. Late send finalization also preserves established
provider delivery outcomes and their evidence. An explicit late refusal resolves both
`sending` and `unknown` recipients without changing known recipient outcomes.
Reconciliation never sends email automatically.
An `unknown` result needs provider reconciliation before considering another send.
The operator panel is supplied by an extension. The SES adapter makes one request per attempt. No idempotency key
means no deduplication. Generated contact receipt timestamps do not change request
identity; recipient, subject, content, Reply-To, ref and explicit markup do.

Sellf uses the generic source engine and requires a Bearer client with `hook:sellf`
scope. `signatureSecretEnv` names the optional runtime signing secret;
`sellfSignatureSecretEnv` remains an alias. When configured, the runtime secret and
`X-Sellf-Signature: t=<unix>,v1=<hex>` are required (HMAC-SHA256 over `${t}.${rawBody}`,
300-second tolerance); invalid credentials return `401 unauthorized`.

Source keys are `source:<id>:<event>:` followed by
`JSON.stringify([brandId, selectedIdentityOrBodyDigest])`, then scoped to the client
by the pipeline. The body fallback is the first 32 hex characters of SHA-256.
The Sellf preset selects PI then CS for purchases, refund ID for refunds, and
order CS/PI then payment CS/PI for other events. Purchase and refund `ref` select
PI then CS; other events use the same selection as their key. Different refund IDs
produce separate deliveries. Missing refund IDs fail the refund template requirement.
Duplicate, pending, conflict and uncertain outcomes follow the table above.
Comparison covers mapped delivery intent; level `none` compares only the key.

Keys expire after 24 hours. The new `source:` namespace does not look up older
`sellf:` keys. Retrying any event sent by the former adapter within that 24-hour
window may send it again; reconcile outstanding deliveries when changing versions.

Set optional `SES_CONFIGURATION_SET` in `.env` and run `npm run setup` to include it in
Worker vars. For local `npx wrangler dev`, it may also be set in `.dev.vars`. Only sends
with a message row include `ConfigurationSetName` and tags `ms_id` (message id),
`ms_brand` (brand id). SES `MessageId` and the encrypted response body are recorded;
response headers are excluded. No open/click tracking configuration is sent.

### Reading the log without the panel

Use Node 24+ and a local SQLite database to read the log offline. These commands
use local files and do not contact the API or email provider:

```bash
node scripts/mailstack.ts log list --db ./data/mailstack.sqlite
node scripts/mailstack.ts log list --db ./data/mailstack.sqlite --brand acme --status sent --since 2026-10-01T00:00:00Z --limit 20
node scripts/mailstack.ts log find --db ./data/mailstack.sqlite --email buyer@example.com --index-keys ./secrets/index-keys.json
node scripts/mailstack.ts log find --db ./data/mailstack.sqlite --email buyer@example.com --index-keys env
node scripts/mailstack.ts log show msg_EXAMPLE --db ./data/mailstack.sqlite --key ./secrets/content-private.json
```

`list` and `find` print a table of message id, creation time (UTC), brand, template,
status and latest delivery event. Add `--json` for JSON output. Results are newest
first, with message id breaking timestamp ties; the default limit is 100 and
`list --limit` accepts 1-100. `--since` accepts a valid calendar ISO timestamp with
seconds and a timezone (`Z` or `±HH:MM`, offset hours 00-23 and minutes 00-59).
Fractional seconds are optional. Impossible dates, out-of-range clock components
(including 24:00 and leap seconds) and missing timezones are rejected before opening
the database. Equivalent UTC and offset timestamps select the same rows.
Lists contain no recipient addresses or address hints. The `none` logging level
creates no message row, so those sends cannot appear in results.

The index-key file contains the same JSON array as `INDEX_KEYS`, for example
`[{"kid":"index-1","key":"<base64url-encoded 32-byte key>"}]`.
`--index-keys env` reads `INDEX_KEYS` from the current environment. Search checks
every supplied key generation and matches recipient, Reply-To and submitter
roles. It trims the address and lowercases its domain; the local part remains
case-sensitive. Keep old index keys available while their messages are retained.

`show` prints JSON containing metadata and the event timeline, including bounce,
complaint and delivery events. For `masked` and `full`, it also opens the archived
projection and stored provider response with the private JWK set created by
`npm run keys -- init ./secrets/content-private.json` (`{"keys":[...]}`). The
archive is labelled `Archived projection (level masked/full)`. For `meta`, it
prints a notice that content was not recorded and returns only metadata and the
timeline. Missing policy metadata, unavailable or expired content, and incorrect
keys produce a readable error and a nonzero exit code. An unsuccessful decrypt
prints no partial result.

Database reads use a read-only connection. Before opening any archived content,
`show` briefly opens a separate connection to append `cli.read` to the existing
audit chain; this is its only database write. The database must therefore permit
that audit append for content reads. If the append fails, content is not opened.
Keys are never printed; decrypted values go only to stdout. The CLI does not
write decrypted output to files or logs. It does not create a missing database
or run migrations. For a separate machine, use a consistent SQLite snapshot (see
[Retention and snapshots](#retention-and-snapshots)) and copy keys separately.

### Retention and snapshots

The Worker has a single minute cron; it runs retention hourly at minute 17 (UTC) and background jobs in every other minute. Expired content, resend data
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
files and leaves other files untouched. The Node runtime schedules these snapshots
daily and at startup when the last snapshot is absent or at least 24 hours old. It retains seven snapshots; with the runtime
running daily, removed data ages out of backups within seven days. Keep keys outside
the database and backup directory. Worker databases use
[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/). Declare the account plan as
`"cloudflare": { "plan": "free" }` or `"paid"` (missing means paid): it sets only the
backup window the panel reports for erasures (7 days on Free, 30 on Paid) and never
disables a feature.

### ntfy alerts

On Node, append these variables to the private `.env` and recreate the service. On
Worker, use `npx wrangler secret put NTFY_URL` and `npx wrangler secret put NTFY_TOKEN`;
supply optional `PANEL_URL` the same way only when a panel exists.

Set optional runtime variables `NTFY_URL` (topic endpoint), `NTFY_TOKEN`
(Bearer secret), and `PANEL_URL` (panel base URL). Without `NTFY_URL`,
alerts are disabled. Configure `logging.defaults.alertOn` or brand/template
overrides with `bounce_permanent`, `complaint`, `reject`, `send_failed`,
`unknown`, or `render_failure`.

Alerts use the stored recipient hint and a bounded summary of diagnostic status
codes and bounce classification; arbitrary provider prose is omitted. They contain
no subject or message content. Message-level events without a matched recipient use
`unassigned` instead of a recipient hint. Templates declaring secret fields use high priority;
others use default priority. `PANEL_URL` adds a link to `/m/<messageId>`.
One attempt per message/type is claimed in guards for the effective `metaDays`
(or seven days when absent). A failed notification is logged without its details
and does not change event or send results. Requests time out after five seconds
and do not follow redirects.

Alerts are best-effort: an ntfy failure at event time does not retry the alert; the message remains visible in the log.

### Extension resend contract

Extensions (Node and the Worker build) opt in with `capabilities: ["resend"]`. The runtime passes
`ctx.resend` only to authenticated internal routes of that extension, with the verified
panel principal bound to it. `viewer` cannot use this port; `operator` and `admin`
need a step-up within five minutes, an unexpired assertion, and matching brand/template
selections. Event hooks do not receive this capability. Extension database queries
are limited to their `ext_<name>_` tables.

Types live in `src/core/resend-contract.ts`:

- `source(messageId)` returns the permitted strategy, brand/template, sealed reference
  and sealed payload (with expiry), or a structured error. Audit must succeed before
  returning sealed data. A source strategy also returns the owning client id and
  callback descriptor (`url`, `secretEnv`), never the secret value.
- `request({messageId, reason, idempotencyKey, envelope})` accepts a 10–500 character
  reason and the normal idempotency key format. `envelope` is a transit envelope sealed
  in the browser for this API, the message and op `resend.replay` (payload `{replay}`, the
  exact decrypted `source().replay`) or `resend.source` (payload `{ref}`); a wrong
  binding or expired envelope is `403 transit_invalid`, a reused one `409 replayed`.
  For `replay`, core validates the payload and awaits the shared delivery pipeline
  (on the Worker through SES). For `source`, it returns `202` with `resendId`, the sealed
  source descriptor and the opened `ref` for the callback. Callback signing, execution, UI and license decisions belong to the
  extension. The extension must declare the capability only when enabled.

The payload contains `to`, `template`, `data`, and optional `replyTo`,
`subjectOverride`, `markup`. The core checks its canonical MAC and recipient index set,
current policy, expiry, template classification and recipient outcomes. Files are not
stored in this payload; messages with attachments cannot use the stored-payload
strategy. Use a source strategy to regenerate their attachments.

An approved source callback sends through `POST /v1/send` with the original brand,
template, recipient set, `resendOf` and the approved `Idempotency-Key`. Only the
original owning client may fulfill it. The endpoint returns no source history.
Every child has `resend_of` and `resend_root` and must have a recorded intent,
including when the current policy has `requireLog: false`.

Jobs and quota reservations last 24 hours. Root quota is a rolling 3/24h with a
10-minute cooldown; actor (20/day) and instance (50/day) quotas use UTC calendar days.
Quotas are reserved atomically at approval. Explicit provider refusal releases the
reservation and permits the same key again; uncertain outcomes retain it. Repeated
keys return the same `resendId`; `sending` returns `in_progress`, `unknown` returns
`outcome_unknown`. A completion interrupted after provider acceptance is reconciled
from the recorded child without another provider call. Retention removes expired jobs.

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

The Node API Compose budget is **512 MiB**, separate from the SMTP sink. It is
sized for sequential requests up to 10 MiB JSON and 7 MiB decoded attachments.
Keep at most **one large send in flight per instance**, including the provider send;
serialize these sends in the caller or proxy. The listener does not enforce this
concurrency bound. More concurrent large requests, extensions, maintenance and larger
archives require their own measured budget; 512 MiB does not cover arbitrary concurrency.
Leave host memory for the sink, panel, filesystem cache and other processes.

`node scripts/attachment-profile.mjs` runs a bounded, sequential regression in a
separate Node API process with real loopback HTTP, SQLite logging and SMTP MIME.
It checks eight prior small sends, 1 MiB, 7 MiB, five files totalling 7 MiB,
decoded limit + 1, JSON bodies at 10 MiB / + 1, eight later small sends,
health, decoded MIME SHA-256 and decrypted archive exclusions. `--fresh` measures
one 7 MiB send without warmup. The RSS ceiling is 384 MiB, leaving 128 MiB of the
Compose budget outside this profile. RSS is not a cgroup measurement.

For Linux container validation, `node scripts/attachment-cgroup.mjs` creates one
isolated TEST Compose project, uses an internal-only network and loopback ports,
and removes its containers, volumes and local image afterward. It refuses to run
alongside another Compose project and requires cached `node:24-alpine` and
`axllent/mailpit:v1.29.7` images. It builds the API locally, measures fresh and warm
runs, records each service's cgroup limit/peak/current/events and process RSS/HWM,
checks `OOMKilled`, verifies MIME checksums and inbox preservation across a Mailpit
restart. Save stdout as measurement evidence. Mailpit has its own 512 MiB budget
and persistent volume. Run this validation on the target runtime before treating
the container budget as confirmed; the host profiler alone cannot establish that.

SES uses `Content.Simple.Attachments`; SMTP receives decoded buffers. Files and their
names are excluded from archives and replays. Only `{count,totalBytes,types}` is stored
in `attachments_meta`. Request MACs include each file's SHA-256, name and type; changing
a file with the same idempotency key returns `409 idempotency_conflict` at levels
`meta`, `masked` and `full`. Level `none` deduplicates by key alone.

## Extensions

Node can load optional modules at startup; Worker does not load or execute them.
Omitting `extensions` is equivalent to `"extensions": []`. At most one extension may
implement `keys(config)`, returning `{ authenticate(token, env), client(id) }` for tokens
other than the full key (Mailstack Pro uses it for scoped clients).

```json
{
  "extensions": [
    { "module": "mailstack-addon", "options": {} }
  ]
}
```

`module` is an installed package name (optionally a package subpath) or an absolute
file path, such as `/opt/mailstack/addon.mjs`. Relative paths are rejected. A module
exports an `Extension` as its default export, or a default factory receiving
`options` and returning an `Extension` (a promise is supported). An import or
initialization error (including a failed `migrate`, `routes` or `keys` hook, or
names sharing a table prefix) marks that extension unavailable: it gets no routes,
events or cleanup calls, a generic log line names `$.extensions.<index>.module`
without module values or exception details, and sending with the full key
continues. While a configured extension is unavailable because of initialization or
missing schema, erasure jobs stay pending without an attempt and retention keeps the
messages it would delete (the job alarm fires after 15 minutes); after the fix and a
restart, erasure runs before any other queued job. Configuration errors (`$.clients`, two key providers) still stop startup.

The contracts live in `src/core/extensions.ts`. Extension names match
`[a-z][a-z0-9_]{0,39}`; a name that equals or prefixes another (`demo`, `demo_x`)
makes both unavailable. All hooks are optional:

- `migrations: [{ version, name, up(db) }]` describe the schema with the Kysely
  schema builder only (create/alter table, create index, drop table; one statement
  per call, no bound values, prefix rules below). Each `up` runs on a recording
  driver; the compiled SQL and its SHA-256 form the manifest. Node applies missing
  versions at start, each in one transaction ending with its row in `ext_migrations`.
  `npm run setup` writes `.wrangler/migrations/<1000+version>_ext_<name>_<version>.sql`
  (ledger row as the last statement; an invalid statement fails setup) for
  inspection or fresh local databases. `npm run release` and the staging deployment use
  the shared schema upgrader, which adopts columns already created by older Node versions.
  Changed ledger checksums stop the upgrade. A manifest version missing from the ledger or with
  another checksum leaves the extension `unavailable: schema`; its routes return
  `503 {code:"extension_unavailable", reason}`. Newer ledger versions are accepted, so
  versions only add (expand); remove columns or tables two releases later at the earliest.
- `reconcile(db, { configSha, cursor })` holds data setup for the current
  configuration and returns `{ cursor }` or `{ done: true }`. It runs as an
  `ext.reconcile` job; a new configuration starts a new `ext_reconcile` generation and
  older generations no longer record progress. Until it finishes the extension is
  `unavailable: reconcile`. It must be idempotent. An optional `reconcileKey` string
  (for example the ids of a keyring) joins the configuration digest, so changing it
  alone starts a new generation.
- `jobs: { <kind>: { run, ready?, dead?, reserveMs?, ops? } }` registers core background jobs
  `ext:<name>:<kind>`. Queue one with `db.enqueue(kind, key, payload)` inside
  `db.batch([...])`: one live job per key; a finished one is revived. The core holds the
  lease (30 s), the token fence and the backoff (1 min, 10 min, 1 h, 6 h). `run` makes one
  attempt and returns sandboxed `writes`, committed only under a valid token, plus
  `retry: true` to count it as failed; after the fifth failure or lost claim the job is
  `dead` and the `dead` writes commit. `ready()` is asked before a job is claimed: false
  leaves it pending without an attempt. Jobs whose extension is not loaded stay pending.
  `ops` (default 6) is the most D1 calls plus subrequests one attempt may take: a Worker
  invocation (Free: 50 D1 calls, the core keeps 40 for its meter, 990 with `cloudflare.plan: "paid"`)
  claims a job only while that fits, and each attempt is charged at least `ops`.
- `migrate(db)` (legacy, Node only) runs before listening. Worker extensions must declare all schema changes in `migrations`; no schema hooks run on Worker requests or cron. Use Kysely schema/query builders and tables
  beginning with `ext_<name>_`; referenced tables must use the same prefix. Raw SQL,
  schema-qualified tables and dropping indexes are not supported. Index names also
  use this prefix. Migrations should be repeatable, for example with `ifNotExists()`.
- `onEvent(event, ctx)` receives send outcomes (`message.sent`,
  `message.send_failed`, `message.unknown`), projected SES outcomes
  (`message.delivered`, `message.bounced`, `message.complained`, or
  `message.send_failed` for rejection/rendering failure), and `form.submitted`
  after a successful public contact submission. Duplicate SES notifications and
  idempotent send responses do not emit another outcome. Explicit send retries
  are new attempts. Events contain only `id`, `type`, `at` (epoch milliseconds),
  `brand`, `template`, `status`, and optional `ref`/`messageId` (the local log id).
  Address, subject and message content are absent. Keep correlation refs opaque.
  Stored events (level other than `none`) arrive from the fan-out with
  `refDigest` instead of `ref`, at least once, one event per step: return
  `{ ack: true, writes }` with the sandboxed delivery writes,
  committed in one batch with the event cursor, or `{ partial: endpointId, writes }` to
  continue later with `onEvent(event, ctx, endpointId)`. Give a delivery an id derived
  from the event and endpoint, so a repeated or concurrent event adds nothing. Work kept in
  the extension's table (with its own lease and token) is offered as `queue: { due, run }`. Anything else
  keeps the event pending; events unconfirmed for 7 days are dropped and recorded as a gap.
  For events from memory the host commits `writes` as one batch.
- `routes(app)` registers exact paths with
  `app.route('GET', '/ping', (request, ctx) => Response.json({ ok: true }))`.
  They are mounted on Node's internal port **8081** and on the Worker's
  `INTERNAL_HOST` (after the Access check), at `/internal/ext/<name>/ping`; the
  public host answers 404. The Worker has no dynamic import: it loads only the
  `mailstack-pro` entry, from the Pro build's `workerExtension` export bundled by
  `npm run setup` with `MAILSTACK_PRO_PATH`. Requests require a configured `panel` client bearer
  token, `X-Panel-Actor`, and a signed `X-Panel-Assertion` as described in the
  [internal API contract](docs/internal-api.md). Do not publish this port externally.
  Extensions must append an audit entry before content reads or state mutations.

`ctx` provides a Kysely `db` handle (with `db.batch([...builders])`: every
element is checked against the prefix before one atomic store batch, so a single
invalid element refuses the whole batch), `appendAudit(entry)`, `now()` (epoch
milliseconds), and `config` containing brand ids and logging policies only.
Route handlers also receive the verified `ctx.panel` principal and must apply its
scopes, selections, role and step-up requirements.
It does not include runtime environment variables, sending keys or client tokens.
Module-specific options are passed only to the factory. Modules run as trusted
in-process Node code, not in a sandbox.

Event hooks run in the background with a five-second wait limit. Exceptions and
timeouts produce a generic log entry and never change the email/API result.
The limit stops waiting; it cannot cancel a module's ongoing work. Modules should
bound their own I/O and avoid blocking the Node event loop. Delivery is best-effort;
there is no persistent event queue in the core.

### Internal panel API

The existing Node listener on port 8081 exposes the sealed log and privacy API.
Panel calls require the configured panel client plus a signed, short-lived actor
assertion; role and step-up checks run in the API. See the [internal API contract](docs/internal-api.md)
for routes, role matrix, `PANEL_ASSERTION_KEYS`, `PANEL_AUDIENCE`, audit behavior and extension integration.

## Test environment

The manual-test sandbox uses synthetic brands and addresses only. It requires Docker
Compose, Node 24+, OpenSSL, and a sibling `mailstack-pro` checkout with dependencies
installed. It never reads the normal `.env`, private brand configuration, or production
credentials. Run from this checkout:

```bash
scripts/test-env.sh up
scripts/test-env.sh seed
scripts/test-env.sh status
scripts/test-env.sh down
```

`up` builds one project, `mailstack-test`. `seed` is idempotent and creates template
samples at levels none/meta/masked/full, a second tenant, a nonce-enabled brand with
products, synthetic clients, signed SES fixtures, and separate expiring records
(metadata after one hour; content/replay after fifteen minutes). Restarting `up`
preserves data; `reset` destroys and recreates the sandbox. After source changes use
`reset`: the build context is a snapshot, not a live source mount.

| Service | Address |
| --- | --- |
| Public API | `http://localhost:18880` |
| Pro panel (self-signed TLS) | `https://localhost:18890` |
| Mailpit inbox | `http://localhost:18825` |
| Request playground | `http://localhost:18882` |
| HTTPS receiver / request history | `https://localhost:18843/records` |

All mail goes to Mailpit, including `.example` recipients. API, panel and Mailpit
have no external network; a fixture gateway publishes their fixed ports on loopback.
The internal API port 8081 is not published. The panel has separate state and private
content keys; API mounts contain public content keys and index keys only. The fixture
gateway holds its own signing keys, never panel content keys. The containers use the
host's non-root UID so private bind-mounted files can remain mode 0600. Mailpit also
runs with that UID; the init container assigns its separate `mailpit-data` volume.
Its database is `/data/mailpit.db`, outside tmpfs, and survives stop/start, restart
and container recreation within a run. `down` and `reset` remove this volume too.
Mailpit has a separate 512 MiB budget: four times the previous 128 MiB allocation,
with headroom for MIME/base64 parsing of a 7 MiB attachment and earlier messages.
This is a test budget, not a measured peak or a guarantee: the full 7 MiB run must
measure sink/API memory separately and verify attachment checksums after prior sends.

`status` prints service addresses and writes account instructions, test tokens, source
SHAs and invitations to `/private/tmp/mailstack-test-local/status.json` (0600).
`invite all` renews viewer/operator/admin invitation links, which expire after fifteen
minutes. Enroll with a Chrome CDP virtual resident authenticator, then authenticate
again for step-up. There are no passwords or owner accounts. Keep each role's virtual
credentials separately. Test profiles must be temporary, headless, and independent
of the owner's browser. Do not log tokens or cookies in evidence.

```bash
scripts/test-env.sh invite all
scripts/test-env.sh license expired  # valid, missing, bad-signature, wrong-domain, revoked
scripts/test-env.sh license valid
scripts/test-env.sh mode '{"hook":"500","ntfy":"timeout"}'
scripts/test-env.sh mode '{"hook":"200","ntfy":"200","license":"200","callback":"200"}'
scripts/test-env.sh exec api cat /data/manual-seed.json
scripts/test-env.sh exec api node /workspace/mailstack-pro/dist/manual-seed.mjs event MESSAGE_ID Bounce EVENT_ID
scripts/test-env.sh exec api node /workspace/mailstack-pro/dist/manual-seed.mjs expire
scripts/test-env.sh exec api node /workspace/mailstack-pro/dist/manual-seed.mjs retention
scripts/test-env.sh logs
```

The HTTPS receiver records exact bodies, signature headers, idempotency keys and
signature validity. It supports 200/500/timeout/redirect modes per hook, ntfy, license
or source callback. For an endpoint created in the panel, verify its signature using
the one-time secret returned at creation; the receiver's built-in `signatureValid`
uses the seeded endpoint secret. Only selected signature, idempotency, content and
notification headers are recorded; Authorization and cookies are not stored or
exported. Existing history is filtered on export too. `/records` remains an array;
`/records/diagnostics` reports recovered count, discarded line numbers (one-based),
byte offsets (zero-based), lengths, and NUL ranges. NUL bytes are removed only in
the read projection; unparsable entries are reported, while later valid entries
remain readable. An affected original is saved byte-for-byte as a mode-0600
`records.jsonl.original-<sha256>` beside the unchanged history. Keep these originals
private, especially for history created by older versions. Response headers
`X-Fixture-Discarded-Records` and `X-Fixture-Nul-Bytes` flag recovery, and the same
diagnostics go to container stderr without record contents. Append uses a fresh
append descriptor and fsync; an unterminated tail is preserved before a separating
newline is added. No historical cause of NUL bytes has been established.
Use its CA at
`/private/tmp/mailstack-test-local/fixture/tls.crt` for host curl requests.

The Pro test composition maps only `license.test.example`, `hooks.test.example` and
`source.test.example` through injected transports to this receiver. Production SSRF
validation is unchanged. Other destinations use the normal resolver and cannot be
sent through the fixture adapter. A local transport test is not evidence of public
DNS rebinding protection or production certificate trust. The panel uses its real
CLI, auth, storage and views; the test build injects only licensing and alert transport.

`event` uses the real SNS verifier and a fixture-signed envelope with a locally supplied
certificate, then the real event handler and extension emitter. It does not bypass
signature verification or alter the public `/v1/events/ses` endpoint. These fixtures
prove local processing and evidence handling, **not AWS certificate trust**. Expiry
helpers change synthetic fixture timestamps; the host clock is never changed.
In the mixed SNS-fixture + SMTP sandbox, SQL and the timeline/proof may say
`delivered` after a fixture Delivery event while the summary still says
`Relay accepted (delivery not confirmed)` because its provider is SMTP. This
difference is intentional: neither the local fixture event nor SMTP relay
acceptance proves final delivery to a real recipient.

The helper drains the dynamic `waitUntil` queue, including nested registrations,
before closing SQLite and printing its event result. Rejected tasks produce a nonzero
exit and no success result; cleanup still runs after the remaining tasks settle.
`body.result: "processed"` means the SES event was recorded; `"duplicate"` means no
new domain event was emitted. `background: "drained"` confirms completion of registered
tasks only. Extension hooks retain their runtime error handling and filters; it does
not assert a queue row or an HTTP webhook. `webhookDelivery: "not_confirmed"` is explicit.

A deterministic local reproducer (no Docker, browser, or provider) exercises the real
SNS verifier, SES handler, extension emitter and SQLite queue writes with a delayed
`onEvent`, Delivery without a notifier, Bounce, Complaint, duplicates, and Bounce before
Delivery. It also checks another nested task level, rejection and cleanup:

```bash
npm test -- test/manual-lifecycle.test.ts
```

For a sandbox retest, first configure an enabled webhook for `acme` / the selected
template and all three event types, targeting `https://hooks.test.example/events`. Send a fresh message
without `ref` and retain its response `id` as `MESSAGE_ID`; use its actual recipient
(the default below is `buyer@acme.example`). Inject Delivery, then repeat the exact
command with the same `EVENT_ID` to obtain `duplicate` without another queue row:

```bash
scripts/test-env.sh exec api node /workspace/mailstack-pro/dist/manual-seed.mjs event MESSAGE_ID Delivery EVENT_ID buyer@acme.example
```

Poll both the durable Pro queue and receiver with a deadline. This read-only host
recipe requires the running sandbox; replace `MESSAGE_ID`. It fails if either side
is missing after 60 seconds. The receiver body must contain the same `messageId` as
the send response, plus the domain event `id` found in the queue:

```bash
python3 - MESSAGE_ID message.delivered <<'PYTHON'
import json, ssl, subprocess, sys, time, urllib.request
message_id, event_type = sys.argv[1:]
context = ssl.create_default_context(cafile='/private/tmp/mailstack-test-local/fixture/tls.crt')
query = """
import Database from 'better-sqlite3';
const db = new Database('/data/mailstack.db', { readonly: true });
const rows = db.prepare(`SELECT event_id, state FROM ext_pro_webhook_deliveries
  WHERE json_extract(body, '$.messageId')=? AND json_extract(body, '$.type')=?`)
  .all(...process.argv.slice(1));
console.log(JSON.stringify(rows)); db.close();
"""
deadline = time.monotonic() + 60
while time.monotonic() < deadline:
    remaining = deadline - time.monotonic()
    rows = json.loads(subprocess.check_output([
        'scripts/test-env.sh', 'exec', 'api', 'node', '--input-type=module', '-e', query,
        message_id, event_type], timeout=min(5, remaining)))
    with urllib.request.urlopen('https://localhost:18843/records', context=context,
                                timeout=min(5, max(.001, deadline - time.monotonic()))) as response:
        records = json.load(response)
    event_ids = {row['event_id'] for row in rows}
    matches = []
    for record in records:
        if record.get('path') != '/events':
            continue
        try:
            body = json.loads(record['body'])
        except (ValueError, KeyError):
            continue
        if (isinstance(body, dict) and body.get('messageId') == message_id
                and body.get('type') == event_type and body.get('id') in event_ids):
            matches.append(record)
    if rows and matches:
        print(json.dumps({'queue': rows, 'receiverAttempts': len(matches), 'messageId': message_id}))
        break
    time.sleep(min(.25, max(0, deadline - time.monotonic())))
else:
    raise SystemExit('Deadline: queue and correlated receiver event not both confirmed')
PYTHON
```

Preserve and independently verify the matching raw receiver body, signature and
idempotency key as described above; a matching body alone does not verify its signature.
Repeat with `Bounce` / `message.bounced` and `Complaint` / `message.complained`, using
distinct source event IDs. For ordering, use a fresh message, inject Bounce before
Delivery, and poll both event types: the late Delivery event keeps the projected bounce
status. For duplicates compare queue event IDs and receiver decisions, since delivery
retries may legitimately add HTTP attempts. Use two fresh messages without `ref` to
verify independent correlation. Restart/retry and inbox preservation are separate
manual acceptance checks; the focused reproducer does not claim them.

Before **every fault or reset**, preserve all earlier mail outside the installation
directory, including raw EML and SHA256, with this paginated capture/check procedure
(use a new evidence directory for each capture):

```bash
python3 - capture /private/tmp/mailstack-inbox-before-fault <<'PY'
import hashlib, json, pathlib, sys, urllib.request
mode, directory = sys.argv[1:]
root = pathlib.Path(directory)
base = 'http://127.0.0.1:18825'
def get(path):
    return urllib.request.urlopen(base + path, timeout=15).read()
def inventory():
    result, start = {}, 0
    while True:
        page = json.loads(get(f'/api/v1/messages?start={start}&limit=50'))
        for message in page['messages']:
            mid = message['ID']
            raw = get(f'/api/v1/message/{mid}/raw')
            result[mid] = hashlib.sha256(raw).hexdigest()
            if mode == 'capture':
                path = root / (mid + '.eml')
                with path.open('xb') as stream:
                    stream.write(raw)
                path.chmod(0o600)
        start += len(page['messages'])
        if start >= page['total']:
            return result
        if not page['messages']:
            raise RuntimeError('Incomplete inbox page')
if mode == 'capture':
    root.mkdir(mode=0o700)
    manifest = inventory()
    path = root / 'sha256.json'
    path.write_text(json.dumps(manifest, sort_keys=True))
    path.chmod(0o600)
elif mode == 'check':
    expected = json.loads((root / 'sha256.json').read_text())
    actual = inventory()
    assert expected and all(actual.get(k) == v for k, v in expected.items()), 'Inbox changed'
else:
    raise ValueError('Use capture or check')
print('Inbox checksums OK')
PY
```

For a restart check, capture a **nonempty** inbox first, run
`docker compose -p mailstack-test -f /private/tmp/mailstack-test-local/compose.yml restart mailpit`,
wait for Mailpit readiness, and repeat the Python block with `check` instead of
`capture` and the same evidence path. All prior IDs/raw checksums must match; new
messages may be present. For the large-attachment trial also download the attachment
and compare its decoded SHA256 with the input file. A destructive reset intentionally
starts an empty inbox; use the saved EML as evidence, not as a claim of persistence.
Keep the original test run's earlier captures before starting another fault.

`down` removes containers, volumes, locally built images and the entire temporary
installation including credentials. The downloaded Mailpit image and evidence saved
outside the installation directory remain. One Compose project and one Chrome at a
time; `up` checks other projects and memory pressure before building.

### Isolated Worker sandbox

```bash
scripts/test-worker.sh deploy
scripts/test-worker.sh status
# When the coordinator has finished using it:
scripts/test-worker.sh destroy
```

This script reads only the agent Vaultwarden item `CF Deploy - General API token`;
it never uses a token from repository `.env` files. It deploys only `mailstack-test`
on `workers.dev`, with the existing `mailstack-preview` D1 and migration 0001.
No custom domain or production route is configured. SES keys are randomly generated
invalid credentials: accepted requests end in `502 send_failed`, with logging, and
cannot send mail. ALTCHA and the nonce challenge work independently of SES.

Before and after each operation it compares the production Worker's deployment JSON;
an unavailable initial fingerprint prevents any mutation. Evidence and the test URL /
token are in `/private/tmp/mailstack-test-worker` (0600 files). The Worker is left
available for coordinator tests. `destroy` removes only that Worker and local test
credentials; the existing preview database and its synthetic rows are retained.
The script does not delete or recreate D1 databases. A missing permission is reported
without preventing local tests. Never run the normal production deploy command for
this sandbox. [Wrangler command reference](https://developers.cloudflare.com/workers/wrangler/commands/).

### Manual-test runner (private coordination files)

```bash
priv/run-manual-tests.sh --dry-run
priv/run-manual-tests.sh             # coordinator only; starts four Codex runs
priv/run-manual-tests.sh --fresh     # explicit new cycle after source/brief changes
```

The private plan, scenarios and charters are in `priv/plans`; six tester briefs are
in `priv/briefs/manual`. The runner executes REG-A, REG-B, EXP-1 and EXP-2 sequentially,
with a fresh local sandbox between runs, a shared browser-slot reservation, resource
checks, capacity retries and report-based resumption. State is `priv/manual.state`,
logs are `priv/run-logs/manual`, and the final table is
`priv/reports/manual-summary.md`. A completed report may still contain product bugs;
completion is not release approval. SMOKE and RETEST are separate coordinator briefs.
Never commit generated tokens, reports containing credentials, or temporary state.

When connecting to SMTP by IP, set `SMTP_TLS_SERVERNAME` to the certificate hostname. This preserves TLS certificate verification with a direct address, including when `SMTP_URL` supplies the connection. The value must be a hostname.

Erasure requires an initialized B2 register with a retained `TOMBSTONE_REGISTRY_ID`.
The API key needs `writeFiles` and `readFiles` on its register prefix. Initialize
`genesis` explicitly on the owner's computer with
`node scripts/backup/init-register.mjs`; see [Erasure register](docs/backup.md#erasure-register)
for installation, retention, deadlines and recovery. Without it, erasure reports
`erasure_registry_unavailable`; local development can explicitly opt out with
`MAILSTACK_DEV_ERASE_WITHOUT_REGISTRY=true`.
