---
Title: Send a transactional email with mailstack
Category: Sending and posting messages
Free/Paid: Free
Workflow file: ../workflows/send-transactional-email-EN.json
---

## Send a transactional email with mailstack

[mailstack](https://github.com/jurczykpawel/mailstack) is a free, self-hosted email sender (Worker/SES or Node/SES/SMTP) - deploy it once and call it from any workflow instead of paying a per-email SaaS API.

## Who's it for

Anyone who wants full ownership of their transactional email pipeline - order confirmations, welcome emails, notices - with their own API and storage; SES/SMTP providers still process delivery data and may charge for sending.

## How it works

A **Configuration** node holds mailstack's URL, your API key and the email's content. A **Code** node assembles the exact JSON `/v1/send` expects, keeping the URL and key out of the email body. An **HTTP Request** node sends it with your API key as a Bearer token (mailstack's trusted mode). mailstack renders a branded HTML + plain-text email and delivers it through SES (Worker/Node) or SMTP (Node). This example ships pre-filled for a `payment` confirmation; setting `orderUrl` adds ViewAction markup automatically. Gmail display requires sender eligibility; see the repo README’s email markup section.

## How to set up

1. Deploy mailstack (Worker: `npm run release`; Node: follow the repo README) and create an API key.
2. Replace the manual trigger with your own (webhook, form, CRM event, cron).
3. Fill in the Configuration node's fields and run once.

## Requirements

- A deployed mailstack instance (self-hosted) and its API key.

## How to customize the workflow

Switch `template` to `welcome`, `received` or `notice` for other email types - each template's fields are documented in mailstack's README. Map the content fields from your real trigger's data instead of typing them in.

Mailstack only renders and sends: the caller owns payment rules and scheduling.
Use the full API key, or a Pro client with `send`, allowed brand/template and
`recipientOverride: true`. Keep production keys in n8n credentials/environment.
Supply `amount` in major units (for example `149.00`), converting provider minor
units first. External `mailTemplates` can change copy/body blocks; opted-in brand
languages accept `locale` (add it in the builder). See the repo `docs/templates.md`.
