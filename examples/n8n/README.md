# n8n workflow templates

Ready-made n8n workflows that send email through [mailstack](https://github.com/jurczykpawel/mailstack) - no SaaS email API, self-hosted.

Each workflow ships in two languages - the logic is byte-identical, only the sticky-note text differs:

- `*-EN.json` - English sticky notes
- `*-PL.json` - polskie sticky notes (node names and code stay English either way)

Import whichever file matches your preference (n8n -> Workflows -> Import from File).

Both templates use mailstack's **trusted mode** (`Authorization: Bearer <API_KEY>`) - never public mode - since n8n is a server-to-server caller, not a browser. See the root [README](../../README.md) for how to deploy mailstack and create an API key.

## Send a transactional email with mailstack

**Files:** `send-transactional-email-EN.json` / `send-transactional-email-PL.json`

The foundational template: any trigger you like feeds a `Configuration` node (recipient, template, content), a `Code` node builds the JSON body mailstack expects, and an `HTTP Request` node POSTs it to `/v1/send`. Ships pre-filled for the `payment` template; swap `template` to `welcome`, `received` or `notice` for the others.

### What it does
1. **When clicking Execute** - a placeholder trigger. Replace it with your own (webhook, form, CRM event, cron...).
2. **Configuration (EDIT ME)** - your mailstack URL/API key/brand, plus the email's content fields.
3. **Build request body** - assembles the `/v1/send` JSON, keeping `baseUrl`/`apiKey` out of the body.
4. **Send email via mailstack** - POSTs it with your API key as a Bearer token.

### Setup
1. Deploy mailstack (see the root README) and create an API key (`wrangler secret put API_KEY`).
2. Fill in **Configuration (EDIT ME)**.
3. Replace the trigger, run once, check the recipient's inbox.

### Customization
- Different email type - change `template` and its fields (see the root README's Templates table).
- Map fields from your real trigger's data instead of typing them in.

---

## Send order confirmation emails with a Gmail action button (mailstack)

**Files:** `purchase-confirmation-gmail-action-EN.json` / `purchase-confirmation-gmail-action-PL.json`

Turns a purchase/order webhook into a branded `payment` confirmation carrying **schema.org markup** - Gmail renders a real "View order" action button in the message bar, plus an optional discount-code badge in the Promotions tab. A showcase for mailstack's markup feature (`docs/superpowers/specs/2026-07-17-email-markup-design.md` in the main repo has the full design).

### What it does
1. **Purchase webhook** - receives your provider's payload. This example expects a generic `{customer:{email,name}, amount, currency, product, orderId, orderUrl}` shape - replace the node with your provider's own trigger if it has one (Stripe, Gumroad, WooCommerce, [Sellf](https://sellf.app)...).
2. **Configuration (EDIT ME)** - maps those fields (adjust the expressions to your provider), plus your mailstack connection details and an optional discount code.
3. **Build request body** - assembles `template: "payment"` plus a `markup` array (`viewAction` + `discountOffer`). Leaving `discountCode` empty drops the discount block automatically - mailstack is fail-soft, the email still sends.
4. **Send confirmation via mailstack** - POSTs it (trusted mode).

### Setup
1. Deploy mailstack, create an API key.
2. Point your provider's webhook at this workflow's Production URL (or swap in its native trigger node).
3. Adjust the field-mapping expressions in **Configuration (EDIT ME)** to your provider's payload shape.
4. Fill in `baseUrl`/`apiKey`/`brand`. Activate.

### Customization
- mailstack's Promotions-tab annotations (discount codes, image cards) render for arbitrary recipients only after Google allowlists your sending domain - action buttons (the "View order" one this template ships) work immediately, no allowlisting needed. See the root README's markup section.
- Add more `markup` directives (`organization`, `promotionCard`, `trackAction`...) in the Code node - see the root README's markup kind table.

**Security note:** this workflow's webhook has no signature verification by design (kept generic across providers) - add your provider's own verification (e.g. Stripe's `Stripe-Signature` header) before trusting the payload in production. See the sticky note on the canvas.

## Building these files

Both are generated from `build.py` (single source of truth - the node graph lives once, only sticky-note text differs per language):

```bash
python3 build.py           # regenerates workflows/*.json
python3 check_layout.py    # verifies canvas geometry + sticky-note word counts
```

Never hand-edit the `workflows/*.json` files - fix `build.py` and regenerate.
