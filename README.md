[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/jurczykpawel/mailstack/actions/workflows/ci.yml/badge.svg)](https://github.com/jurczykpawel/mailstack/actions/workflows/ci.yml)

# mailstack

**Your own email-sending service — a free, self-hosted alternative to Web3Forms / Formspree.**

Put mailstack between your website's contact form (or your app) and your inbox. It catches the
submission, blocks spam, and sends you a clean, branded email. You run it on your own free
Cloudflare account and it sends through Amazon's email service — so there are **no monthly fees**
and your data only ever passes through accounts **you** control.

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
wrangler kv namespace create RATE_LIMIT
wrangler kv namespace create RATE_LIMIT --preview
```
Each command prints an **id** — copy both. Then create your settings file:
```bash
cp .env.example .env
```
Open **`.env`** and paste the two ids (leave the domain empty for now):
```
MAILSTACK_KV_ID=<the first id>
MAILSTACK_KV_PREVIEW_ID=<the second id>
MAILSTACK_ROUTE=
```

### 6) Describe your "brand" (who the email is from and to)
Open **`src/brands.ts`**. There's an example called `acme` — change it to yours:
```ts
acme: {
  id: "acme",
  name: "My Website",
  from: "My Website <hello@yourdomain.com>",   // MUST be the address you verified in SES (step 3)
  to: ["me@yourdomain.com"],                    // where contact-form submissions land
  allowedOrigins: ["https://yourwebsite.com"],  // your site's web address
  subjectPrefix: "New message from",
  autoReply: true,                              // auto "thanks" reply to the visitor (optional)
  theme: { accent: "#0064BC", siteUrl: "https://yourwebsite.com" },
},
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
```bash
npm run deploy
```
Cloudflare gives you a URL like `https://mailstack.<your-name>.workers.dev`. Check it works:
```bash
curl https://mailstack.<your-name>.workers.dev/health
# → {"ok":true,"service":"mailstack"}
```
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
- **Cloudflare** (Workers, KV, Turnstile): generous free tiers — 100,000 Worker requests/day.
- **Amazon SES**: about **$0.10 per 1,000 emails** (often with a free monthly allowance). A
  contact form will almost certainly stay free.

## Updating it later
Change a setting (edit `.env` or `src/brands.ts`) and run `npm run deploy` again. That's the
*entire* maintenance — there's no server to patch or keep running.

## Troubleshooting
- **Email not arriving?** You're probably still in SES "sandbox" — verify the recipient address
  (or request production access). Also check your spam folder.
- **"verification failed"?** The Turnstile widget wasn't solved, or your Site/Secret keys don't match.
- **"origin not allowed"?** Add your site's address to `allowedOrigins` in `src/brands.ts`, redeploy.
- **"send failed"?** Your `from` address isn't verified in SES, or the SES region doesn't match
  where you verified it (set it in `.env` is for KV; the region is in `wrangler.template.toml` →
  `SES_REGION`).

---

# Reference (for developers)

### Highlights
- **Multi-brand** — many tenants in one Worker; brand from `?brand=` or the request `Origin`.
- **Anti-relay** — the recipient is always the server-side `brand.to`; the request body can never redirect mail.
- **Two modes** — public (Turnstile + origin + honeypot + rate limit) and trusted (Bearer token).
- **Template types** — `contact`, `welcome`, `received`, `payment`, `notice`; one branded layout.
- **Auto-reply** — optional confirmation to the submitter, sent non-blocking via `ctx.waitUntil`.
- **Sellf webhook adapter** — maps e-commerce events to branded emails (`/v1/hooks/sellf`).
- **No database** — rate limit in KV, everything else stateless. **Secret scanning** in pre-commit + CI.

### Config files
Nothing deployment-specific is committed — `npm run setup` (also run before `dev`/`deploy`/`test`/
`typecheck`) generates it from committed templates:

| Generated (gitignored) | From | Holds |
|---|---|---|
| `wrangler.toml` | `wrangler.template.toml` + `.env` | KV ids + custom domain (`MAILSTACK_*` vars) |
| `src/brands.ts` | `src/brands.example.ts` | Brand registry (sender, recipients, theme) |
| `src/assets/logo.ts` | `src/assets/logo.example.ts` | Brand logo PNG (base64) |

Configure via **`.env`** and **`src/brands.ts`**; secrets via `wrangler secret put`. Full
deployment notes and architecture: see [AGENTS.md](AGENTS.md).

### API (summary)
- `GET /health` → `{ ok: true }`.
- `POST /v1/send` — public (browser form, needs Turnstile) or trusted (Bearer token). Control
  keys: `brand` (required), `cf-turnstile-response`, `botcheck`, `subject`/`to`/`replyTo`/
  `template`/`autoreply` (trusted only). Everything else is email content.
- `POST /v1/hooks/sellf` — Sellf webhook adapter (Bearer-only). See [AGENTS.md](AGENTS.md).

### Security model
Origin allow-list (CORS reflects the exact origin, never `*`) · server-side Turnstile (fails
closed) · honeypot · fixed recipient / anti-relay · KV rate limit (8/hour per brand+IP) ·
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

### Contributing & license
See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under **MIT** — see [LICENSE](LICENSE).
