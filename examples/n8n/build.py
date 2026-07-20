#!/usr/bin/env python3
"""
Single source of truth for mailstack's n8n workflow templates.

Run:  python3 build.py     -> regenerates every file under workflows/

DRY rule (see vault n8n-template-publishing-guidelines.md section 9):
- The node graph (HTTP/Set/Code/Webhook config, connections, positions) lives here
  ONCE and is language-neutral: node names + Code stay English in both variants.
- The ONLY per-language difference is the sticky-note text in each STRINGS dict.
- Never hand-edit the generated *.json files; fix the logic here and regenerate.

GOTCHA (n8n-template-publishing-guidelines.md section 8, item 4): the n8n-mcp
validator false-flags multi-segment `{{ }}` expressions inside a JSON body/array as
"nested expressions". Fix: build the request body as a plain JS object in a Code
node and give the HTTP node a single `={{ JSON.stringify($json.body) }}` expression
instead of a JSON-text field full of individual `{{ }}` placeholders.
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "workflows")
Y = 300


def sticky(id_, name, pos, w, h, color, content):
    return {
        "id": id_, "name": name, "type": "n8n-nodes-base.stickyNote", "typeVersion": 1,
        "position": pos, "parameters": {"content": content, "width": w, "height": h, "color": color},
    }


def code(id_, name, x, js):
    return {
        "id": id_, "name": name, "type": "n8n-nodes-base.code", "typeVersion": 2,
        "position": [x, Y], "parameters": {"jsCode": js},
    }


def http_send(id_, name, x):
    return {
        "id": id_, "name": name, "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.3,
        "position": [x, Y], "onError": "continueRegularOutput",
        "parameters": {
            "method": "POST",
            "url": "={{ $json.baseUrl }}/v1/send",
            "sendHeaders": True,
            "headerParameters": {"parameters": [
                {"name": "Authorization", "value": "=Bearer {{ $json.apiKey }}"},
            ]},
            "sendBody": True,
            "contentType": "json",
            "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify($json.body) }}",
            "options": {},
        },
    }


def set_node(id_, name, x, assigns):
    return {
        "id": id_, "name": name, "type": "n8n-nodes-base.set", "typeVersion": 3.4,
        "position": [x, Y],
        "parameters": {
            "assignments": {"assignments": [
                {"id": f"a{i}", "name": k, "value": v, "type": "string"}
                for i, (k, v) in enumerate(assigns, 1)
            ]},
            "includeOtherFields": False,
            "options": {},
        },
    }


SECTION_Y, SECTION_H = 160, 420


def section(id_, name, x, w, content):
    return sticky(id_, name, [x, SECTION_Y], w, SECTION_H, 7, content)


# --------------------------------------------------------------------------------- #
#  Template 1: send a transactional email (generic trigger -> mailstack /v1/send)     #
# --------------------------------------------------------------------------------- #
STRINGS_SEND = {
    "en": {
        "file": "send-transactional-email-EN.json",
        "wf_name": "Send a transactional email with mailstack",
        "overview": """## Send self-hosted transactional emails with mailstack

[mailstack](https://github.com/jurczykpawel/mailstack) is a free, self-hosted email sender (Cloudflare Worker + Amazon SES) you deploy once and call from anywhere - no SaaS email API, no per-email pricing, no vendor lock-in.

### How it works
- A **Configuration** node holds your mailstack URL, API key and the email's content (this example sends a `payment` confirmation - mailstack also ships `welcome`, `received` and `notice` templates).
- **Build request body** assembles the JSON mailstack expects (keeping your URL and API key out of the body).
- The **HTTP Request** POSTs it to `/v1/send` with your API key as a Bearer token (trusted mode) - mailstack renders a branded HTML+text email and sends it via Amazon SES.
- Setting `orderUrl` also makes mailstack add a Gmail action button ("View order") automatically - no extra config needed.

### Setup
1. Deploy mailstack (`git clone` + `wrangler deploy` - see the repo README) and note its URL and your brand id.
2. Create an API key: set the `API_KEY` secret with `wrangler secret put API_KEY`.
3. Replace the **When clicking Execute** trigger with your own (webhook, form, CRM event, cron...).
4. Fill in **Configuration (EDIT ME)**: `baseUrl`, `apiKey`, `brand`, and the email fields.
5. Run once - check the recipient's inbox.

### Customization tips
Change `template` to `welcome`, `received` or `notice` for other email types (see the mailstack README for each template's fields). Map `to`/`name`/`amount`/etc. from your trigger's data instead of typing them in.
""",
        "sec1": "## 1. What to send\nTrigger your flow, then fill in the recipient, template and content in Configuration.",
        "sec2": "## 2. Send it\nBuild the JSON body mailstack expects and POST it with your API key as a Bearer token.",
        "warning": "## Keep your API key secret\nThe mailstack API key unlocks trusted mode (any recipient, any template). Store it in n8n credentials/environment for production - don't commit workflows with a real key.",
    },
    "pl": {
        "file": "send-transactional-email-PL.json",
        "wf_name": "Wyślij mail transakcyjny przez mailstack",
        "overview": """## Wysyłaj self-hostowane maile transakcyjne przez mailstack

[mailstack](https://github.com/jurczykpawel/mailstack) to darmowy, samodzielnie hostowany wysyłacz e-maili (Cloudflare Worker + Amazon SES), który wdrażasz raz i wywołujesz skądkolwiek - bez SaaS-owego API do maili, bez płacenia za sztukę, bez vendor lock-inu.

### Jak to działa
- Node **Configuration** trzyma adres mailstacka, klucz API i treść maila (ten przykład wysyła potwierdzenie `payment` - mailstack ma też szablony `welcome`, `received` i `notice`).
- **Build request body** buduje JSON, jakiego oczekuje mailstack (adres i klucz API zostają poza treścią body).
- **HTTP Request** wysyła POST na `/v1/send` z kluczem API jako Bearer token (tryb zaufany) - mailstack renderuje branded mail HTML+text i wysyła go przez Amazon SES.
- Ustawienie `orderUrl` sprawia, że mailstack automatycznie dodaje przycisk akcji w Gmailu ("Zobacz zamówienie") - bez dodatkowej konfiguracji.

### Konfiguracja
1. Wdróż mailstack (`git clone` + `wrangler deploy` - patrz README repo) i zanotuj jego adres oraz id brandu.
2. Utwórz klucz API: ustaw sekret `API_KEY` przez `wrangler secret put API_KEY`.
3. Podmień trigger **When clicking Execute** na własny (webhook, formularz, event z CRM, cron...).
4. Uzupełnij **Configuration (EDIT ME)**: `baseUrl`, `apiKey`, `brand` i pola maila.
5. Uruchom raz - sprawdź skrzynkę odbiorcy.

### Wskazówki
Zmień `template` na `welcome`, `received` lub `notice` dla innych typów maili (pola każdego szablonu - patrz README mailstacka). Podepnij `to`/`name`/`amount`/itd. z danych triggera zamiast wpisywać je na sztywno.
""",
        "sec1": "## 1. Co wysłać\nUruchom flow, potem uzupełnij odbiorcę, szablon i treść w Configuration.",
        "sec2": "## 2. Wyślij\nZbuduj JSON, jakiego oczekuje mailstack, i wyślij POST z kluczem API jako Bearer token.",
        "warning": "## Chroń swój klucz API\nKlucz API mailstacka odblokowuje tryb zaufany (dowolny odbiorca, dowolny szablon). W produkcji trzymaj go w credentials/zmiennych środowiskowych n8n - nie commituj workflowa z prawdziwym kluczem.",
    },
}

SEND_CONFIG_FIELDS = [
    ("baseUrl", "https://mail.yourdomain.com"),
    ("apiKey", "your-mailstack-api-key"),
    ("brand", "acme"),
    ("template", "payment"),
    ("to", "customer@example.com"),
    ("name", "Jane Smith"),
    ("amount", "149.00"),
    ("currency", "PLN"),
    ("item", "Pro Plan"),
    ("orderId", "ORD-7788"),
    ("date", "2026-07-19"),
    ("invoiceUrl", "https://example.com/invoice/ORD-7788.pdf"),
    ("orderUrl", "https://example.com/orders/ORD-7788"),
]

JS_BUILD_SEND = r"""// Assemble the mailstack /v1/send body from Configuration, keeping baseUrl/apiKey
// out of it (those configure the HTTP request itself, not the email content).
const c = $input.first().json;
const body = {
  brand: c.brand,
  template: c.template,
  to: c.to,
  name: c.name,
  amount: c.amount,
  currency: c.currency,
  item: c.item,
  orderId: c.orderId,
  date: c.date,
  invoiceUrl: c.invoiceUrl,
  orderUrl: c.orderUrl,
};
return [{ json: { baseUrl: c.baseUrl, apiKey: c.apiKey, body } }];"""


def build_send(lang):
    s = STRINGS_SEND[lang]
    nodes = [
        {"id": "trigger", "name": "When clicking Execute", "type": "n8n-nodes-base.manualTrigger",
         "typeVersion": 1, "position": [0, Y], "parameters": {}},
        set_node("config", "Configuration (EDIT ME)", 300, SEND_CONFIG_FIELDS),
        code("build", "Build request body", 600, JS_BUILD_SEND),
        http_send("send", "Send email via mailstack", 900),
        sticky("st0", "Sticky Note", [-60, -420], 1020, 340, 1, s["overview"]),
        section("sec1", "Sticky Note2", -60, 480, s["sec1"]),
        section("sec2", "Sticky Note3", 560, 460, s["sec2"]),
        sticky("st1", "Sticky Note1", [280, 620], 300, 160, 3, s["warning"]),
    ]
    order = ["When clicking Execute", "Configuration (EDIT ME)", "Build request body", "Send email via mailstack"]
    connections = {order[i]: {"main": [[{"node": order[i + 1], "type": "main", "index": 0}]]}
                   for i in range(len(order) - 1)}
    return {"name": s["wf_name"], "nodes": nodes, "connections": connections,
            "settings": {"executionOrder": "v1"}}


# --------------------------------------------------------------------------------- #
#  Template 2: purchase webhook -> confirmation email with a Gmail action button      #
# --------------------------------------------------------------------------------- #
STRINGS_PURCHASE = {
    "en": {
        "file": "purchase-confirmation-gmail-action-EN.json",
        "wf_name": "Send order confirmation emails with a Gmail action button (mailstack)",
        "overview": """## Turn purchase webhooks into a branded confirmation email with a Gmail action button

Receives a purchase/order webhook (from Stripe, Gumroad, WooCommerce, [Sellf](https://sellf.app) or your own checkout), then sends the buyer a branded confirmation through [mailstack](https://github.com/jurczykpawel/mailstack) - a free, self-hosted email sender. The email carries **schema.org markup**, so Gmail renders a real "View order" action button in the message bar, plus an optional discount-code badge in the Promotions tab.

### How it works
- The **Purchase webhook** receives your provider's payload (this example expects a generic `{customer:{email,name}, amount, currency, product, orderId, orderUrl}` shape).
- **Configuration (EDIT ME)** maps those fields (adjust the expressions to match your provider) plus your mailstack connection details and an optional discount code.
- **Build request body** assembles `template: "payment"` plus a `markup` array: a `viewAction` (the Gmail button) and a `discountOffer`. mailstack drops the discount block automatically if you leave `discountCode` empty - the email still sends.
- The **HTTP Request** POSTs it to `/v1/send` (trusted mode).

### Setup
1. Deploy mailstack and create an API key (see its README).
2. Point your payment provider's webhook at this workflow's Production URL, or replace the **Purchase webhook** node with the provider's own trigger node if it has one.
3. Adjust the expressions in **Configuration (EDIT ME)** to match your provider's payload field names.
4. Fill in `baseUrl`, `apiKey`, `brand`; leave `discountCode` empty to send a plain confirmation.
5. Activate the workflow.

### Customization tips
mailstack's Promotions-tab annotations (discount codes, image cards) currently render for arbitrary recipients only after Google allowlists your sending domain - see mailstack's README. Action buttons work immediately, no allowlisting needed.
""",
        "sec1": "## 1. Receive + map the order\nThe webhook receives your provider's payload; Configuration maps it to mailstack's fields.",
        "sec2": "## 2. Build + send the email\nAssemble the payment email with its Gmail action button/discount markup, then POST it to mailstack.",
        "warning": "## Secure this webhook before going live\nAnyone who finds this URL can trigger a fake confirmation email. Add your provider's signature verification (e.g. Stripe-Signature) in front of Configuration, or a shared-secret header check.",
    },
    "pl": {
        "file": "purchase-confirmation-gmail-action-PL.json",
        "wf_name": "Wyślij potwierdzenie zamówienia z przyciskiem akcji Gmail (mailstack)",
        "overview": """## Zamień webhook zamówienia w branded mail potwierdzający z przyciskiem akcji Gmail

Odbiera webhook zamówienia/zakupu (ze Stripe, Gumroad, WooCommerce, [Sellf](https://sellf.app) albo własnego checkoutu) i wysyła kupującemu branded potwierdzenie przez [mailstack](https://github.com/jurczykpawel/mailstack) - darmowy, samodzielnie hostowany wysyłacz maili. Mail niesie **markup schema.org**, więc Gmail pokazuje prawdziwy przycisk akcji "Zobacz zamówienie" na pasku wiadomości oraz opcjonalny badge z kodem rabatowym w zakładce Oferty.

### Jak to działa
- **Purchase webhook** odbiera payload Twojego dostawcy (przykład zakłada ogólny kształt `{customer:{email,name}, amount, currency, product, orderId, orderUrl}`).
- **Configuration (EDIT ME)** mapuje te pola (dostosuj wyrażenia do swojego dostawcy) plus dane połączenia z mailstackiem i opcjonalny kod rabatowy.
- **Build request body** buduje `template: "payment"` oraz tablicę `markup`: `viewAction` (przycisk Gmail) i `discountOffer`. Mailstack automatycznie pomija blok rabatu, jeśli zostawisz `discountCode` puste - mail i tak wychodzi.
- **HTTP Request** wysyła POST na `/v1/send` (tryb zaufany).

### Konfiguracja
1. Wdróż mailstack i utwórz klucz API (patrz README).
2. Wskaż webhook swojego dostawcy płatności na Production URL tego workflowa, albo podmień node **Purchase webhook** na natywny trigger dostawcy, jeśli taki ma.
3. Dostosuj wyrażenia w **Configuration (EDIT ME)** do nazw pól w payloadzie Twojego dostawcy.
4. Uzupełnij `baseUrl`, `apiKey`, `brand`; zostaw `discountCode` puste, żeby wysłać zwykłe potwierdzenie.
5. Aktywuj workflow.

### Wskazówki
Adnotacje mailstacka w zakładce Oferty (kody rabatowe, karty z obrazkiem) renderują się dla dowolnych odbiorców dopiero po allowliście domeny u Google - patrz README mailstacka. Przyciski akcji działają od razu, bez allowlisty.
""",
        "sec1": "## 1. Odbierz i zmapuj zamówienie\nWebhook odbiera payload dostawcy; Configuration mapuje go na pola mailstacka.",
        "sec2": "## 2. Zbuduj i wyślij mail\nZłóż mail payment z przyciskiem Gmail/markupem rabatu i wyślij POST do mailstacka.",
        "warning": "## Zabezpiecz ten webhook przed produkcją\nKtokolwiek znajdzie ten URL, może wywołać fałszywy mail potwierdzający. Dodaj weryfikację podpisu swojego dostawcy (np. Stripe-Signature) przed Configuration, albo sprawdzenie współdzielonego sekretu w nagłówku.",
    },
}

PURCHASE_CONFIG_FIELDS = [
    ("baseUrl", "https://mail.yourdomain.com"),
    ("apiKey", "your-mailstack-api-key"),
    ("brand", "acme"),
    ("to", "={{ $json.body.customer.email }}"),
    ("name", "={{ $json.body.customer.name }}"),
    ("amount", "={{ $json.body.amount }}"),
    ("currency", "={{ $json.body.currency }}"),
    ("item", "={{ $json.body.product }}"),
    ("orderId", "={{ $json.body.orderId }}"),
    ("orderUrl", "={{ $json.body.orderUrl }}"),
    ("discountCode", ""),
    ("discountDescription", "10% off your next course"),
]

JS_BUILD_PURCHASE = r"""// Assemble the mailstack /v1/send body: a payment confirmation with a Gmail
// action button, plus a discount badge IF a discount code was configured.
// mailstack drops incomplete markup directives on its own (fail-soft), but we
// only bother sending the discountOffer block at all when there's a code to show.
const c = $input.first().json;
const markup = [
  { kind: 'viewAction', name: 'View order', url: c.orderUrl },
];
if (c.discountCode) {
  markup.push({ kind: 'discountOffer', discountCode: c.discountCode, description: c.discountDescription });
}
const body = {
  brand: c.brand,
  template: 'payment',
  to: c.to,
  name: c.name,
  amount: c.amount,
  currency: c.currency,
  item: c.item,
  orderId: c.orderId,
  orderUrl: c.orderUrl,
  markup,
};
return [{ json: { baseUrl: c.baseUrl, apiKey: c.apiKey, body } }];"""


def build_purchase(lang):
    s = STRINGS_PURCHASE[lang]
    nodes = [
        {"id": "webhook", "name": "Purchase webhook", "type": "n8n-nodes-base.webhook",
         "typeVersion": 2.1, "position": [0, Y], "onError": "continueRegularOutput",
         "webhookId": "mailstack-purchase-confirmation-example",
         "parameters": {"httpMethod": "POST", "path": "mailstack-purchase-confirmation",
                        "responseMode": "lastNode", "options": {}}},
        set_node("config", "Configuration (EDIT ME)", 300, PURCHASE_CONFIG_FIELDS),
        code("build", "Build request body", 600, JS_BUILD_PURCHASE),
        http_send("send", "Send confirmation via mailstack", 900),
        sticky("st0", "Sticky Note", [-60, -460], 1020, 380, 1, s["overview"]),
        section("sec1", "Sticky Note2", -60, 480, s["sec1"]),
        section("sec2", "Sticky Note3", 560, 460, s["sec2"]),
        sticky("st1", "Sticky Note1", [-20, 620], 300, 160, 3, s["warning"]),
    ]
    order = ["Purchase webhook", "Configuration (EDIT ME)", "Build request body", "Send confirmation via mailstack"]
    connections = {order[i]: {"main": [[{"node": order[i + 1], "type": "main", "index": 0}]]}
                   for i in range(len(order) - 1)}
    return {"name": s["wf_name"], "nodes": nodes, "connections": connections,
            "settings": {"executionOrder": "v1"}}


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for build_fn, strings in ((build_send, STRINGS_SEND), (build_purchase, STRINGS_PURCHASE)):
        for lang in ("en", "pl"):
            wf = build_fn(lang)
            path = os.path.join(OUT, strings[lang]["file"])
            with open(path, "w") as f:
                json.dump(wf, f, ensure_ascii=False, indent=2)
            funcs = len([n for n in wf["nodes"] if "stickyNote" not in n["type"]])
            print(f"[{lang}] {strings[lang]['file']}  ({funcs} nodes + stickies)")
