---
Title: Send order confirmation emails with a Gmail action button using mailstack
Category: Sending and posting messages
Free/Paid: Free
Workflow file: ../workflows/purchase-confirmation-gmail-action-EN.json
---

## Send order confirmation emails with a Gmail action button using mailstack

Turns a purchase webhook into a branded order-confirmation email carrying markup for an **action button in Gmail's message bar** ("View order"), plus an optional discount-code badge in the Promotions tab - powered by [mailstack](https://github.com/jurczykpawel/mailstack), a free, self-hosted email sender, using schema.org email markup.

## Who's it for

Store owners and course creators on Stripe, Gumroad, WooCommerce, Sellf or a custom checkout who want order confirmations that stand out in the inbox, without adopting a SaaS email platform just to get "Gmail actions".

## How it works

A **webhook** receives your provider's purchase payload. A **Configuration** node maps its fields (customer email/name, amount, product, order id/url) plus an optional discount code. A **Code** node builds mailstack's `payment` email with a `markup` array: a `viewAction` (the Gmail button) and, only if a discount code was configured, a `discountOffer`. mailstack is fail-soft - an empty discount code is simply skipped, the confirmation still sends. An **HTTP Request** node posts it to mailstack's `/v1/send` (trusted mode).

## How to set up

1. Deploy mailstack and create an API key.
2. Point your payment provider's webhook at this workflow's Production URL (or swap in its native n8n trigger node).
3. Adjust the field-mapping expressions in Configuration to your provider's payload shape, fill in your mailstack URL/key/brand, and activate.

## Requirements

- A deployed mailstack instance and its API key.
- A purchase/order webhook source (Stripe, Gumroad, WooCommerce, Sellf, or your own checkout).

## How to customize the workflow

Add more markup directives in the Code node - a shipment tracking action, a promo image card, your organization's logo - see mailstack's README for every supported kind. Note: Gmail actions and Promotions annotations require sender eligibility for arbitrary recipients; markup alone does not guarantee display.

Mailstack only renders and sends: the caller owns payment rules and scheduling.
Use the full API key, or a Pro client with `send`, allowed brand/template and
`recipientOverride: true`. Keep production keys in n8n credentials/environment.
Supply `amount` in major units (for example `149.00`), converting provider minor
units first. External `mailTemplates` can change copy/body blocks; opted-in brand
languages accept `locale` (add it in the builder). See the repo `docs/templates.md`.

The generic webhook has no provider signature verification: add it before
Configuration in production. This payload is not the Sellf `/v1/hooks/sellf`
envelope; map your provider’s fields, amount units and event filtering explicitly.
