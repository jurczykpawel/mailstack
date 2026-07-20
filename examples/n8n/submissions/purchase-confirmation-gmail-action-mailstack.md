---
Title: Send order confirmation emails with a Gmail action button using mailstack
Category: Sending and posting messages
Free/Paid: Free
Workflow file: ../workflows/purchase-confirmation-gmail-action-EN.json
---

## Send order confirmation emails with a Gmail action button using mailstack

Turns a purchase webhook into a branded order-confirmation email that renders a real **action button in Gmail's message bar** ("View order"), plus an optional discount-code badge in the Promotions tab - powered by [mailstack](https://github.com/jurczykpawel/mailstack), a free, self-hosted email sender, using schema.org email markup.

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

Add more markup directives in the Code node - a shipment tracking action, a promo image card, your organization's logo - see mailstack's README for every supported kind. Note: Gmail's Promotions-tab annotations (the discount badge) render for arbitrary recipients only once Google allowlists your sending domain; the action button works immediately.
