---
Title: Send a transactional email with mailstack
Category: Sending and posting messages
Free/Paid: Free
Workflow file: ../workflows/send-transactional-email-EN.json
---

## Send a transactional email with mailstack

[mailstack](https://github.com/jurczykpawel/mailstack) is a free, self-hosted email sender (Cloudflare Worker + Amazon SES) - deploy it once and call it from any workflow instead of paying a per-email SaaS API.

## Who's it for

Anyone who wants full ownership of their transactional email pipeline - order confirmations, welcome emails, notices - without a monthly email-API bill or a third party reading their customers' addresses.

## How it works

A **Configuration** node holds mailstack's URL, your API key and the email's content. A **Code** node assembles the exact JSON `/v1/send` expects, keeping the URL and key out of the email body. An **HTTP Request** node sends it with your API key as a Bearer token (mailstack's trusted mode). mailstack renders a branded HTML + plain-text email and delivers it through Amazon SES. This example ships pre-filled for a `payment` confirmation; setting `orderUrl` also makes mailstack add a Gmail action button automatically, no extra config.

## How to set up

1. Deploy mailstack (`wrangler deploy` - the repo README walks through Cloudflare + Amazon SES setup) and create an API key.
2. Replace the manual trigger with your own (webhook, form, CRM event, cron).
3. Fill in the Configuration node's fields and run once.

## Requirements

- A deployed mailstack instance (free, self-hosted, ~10 minutes to set up) and its API key.

## How to customize the workflow

Switch `template` to `welcome`, `received` or `notice` for other email types - each template's fields are documented in mailstack's README. Map the content fields from your real trigger's data instead of typing them in.
