# Staging

Use synthetic `acme`/`demo` brands and a separate installation, database, hostnames,
keys and register prefix. Infrastructure addresses, account inventories, credentials
and live version records belong in private operator state, not this document.
Do not infer a deployed version or available quota from a repository report.

## Private operator configuration

Staging/manual scripts require explicit installation identities. They read a flat
JSON object of `MAILSTACK_*` strings from
`~/.config/mailstack-staging/operator.json`, or `MAILSTACK_STAGING_OPERATOR`.
Keep it outside the checkout with mode `0600`; environment variables override JSON.
Without a file, supply the required variables directly. Missing values stop the
script before contacting a provider. Keep tokens in protected environment/state
or a password manager; the JSON only needs installation identities and item names.

Create the directory with mode `0700`, then write your own values, for example:

```json
{
  "MAILSTACK_STAGING_ACCOUNT_ID": "<staging-cloudflare-account-id>",
  "MAILSTACK_PRODUCTION_ACCOUNT_ID": "<production-cloudflare-account-id>",
  "MAILSTACK_STAGING_STATE": "/home/operator/.config/mailstack-staging/worker",
  "MAILSTACK_STAGING_TOKEN_ITEM": "<your-staging-token-item>",
  "MAILSTACK_PRODUCTION_TOKEN_ITEM": "<your-read-only-production-token-item>",
  "MAILSTACK_PRODUCTION_HEALTH_URL": "https://mail.example.com/health"
}
```

`CLOUDFLARE_API_TOKEN` and `MAILSTACK_PRODUCTION_API_TOKEN` override password-manager
lookups. `CLOUDFLARE_ACCOUNT_ID` is a fallback for the staging account when
`MAILSTACK_STAGING_ACCOUNT_ID` is absent. Never commit operator configuration,
resource inventories, Access/Tunnel IDs, credentials or live version records.

## Worker account separation

Create a dedicated Cloudflare account for Worker API tests, D1 tests, CPU
measurements and the minute cron. Configure its workers.dev subdomain. The script
uses `https://mailstack-staging.<your-subdomain>.workers.dev` and a separate
`mailstack-staging-license` fixture Worker. Preview URLs stay off. The production
account supplies only the read-only deployment fingerprint and health check.
D1 quotas must be measured on the account hosting the database.

Enable Zero Trust. Protect the API's `/internal/*` paths with an Access application
and a `non_identity` policy admitting only profile (b)'s dedicated service token.
Configure profile (b) with that origin, matching audience, scoped panel token and
assertion keyring. Public send, health and SNS paths remain public. Profile (a)'s
panel Worker needs its own D1 and operator-only Access policy, uses the API's
`Internal` service binding and has no cron. A new panel origin needs a fresh
invitation and passkey enrollment. Node panels also need Tunnel + Access.

Supply `MAILSTACK_STAGING_PRO`, `MAILSTACK_STAGING_CONFIG` and
`MAILSTACK_STAGING_EGRESS_URL` as needed. Egress is a separate protected VPS
service, for example `https://egress.staging.example.com`, with its own Access
service token and signing keyring. See [architecture](architecture.md#network-and-egress).
The generic Worker composition does not provision Access: retain an operator
launcher that applies the internal host, audience and Access configuration before
using the live installation. Keep its state and helpers outside the checkout.

The default routing is `workers-dev`. For legacy custom-domain staging explicitly
set `MAILSTACK_STAGING_ROUTING=custom-domain`, the original protected state path,
`MAILSTACK_STAGING_HOST`, `MAILSTACK_STAGING_LICENSE_HOST`,
`MAILSTACK_STAGING_INTERNAL_HOST` and `MAILSTACK_STAGING_ZONE` to your own hosts/zone.
Set `MAILSTACK_ACCESS_TEAM_DOMAIN` and `MAILSTACK_ACCESS_AUD` when deploying Pro.
An existing state record must match the account, database and hostname. Never
point a new account at another installation's state or reset an SES ledger when
moving databases. Keep the production fingerprint guard around every mutation.

When moving a panel to a different API database, retain its SQLite backup and
old audit checkpoints before accepting the new installation's checkpoint through
the panel's `integrity accept` CLI with an explicit migration reason. Verify
`verified` afterward; health and an Access redirect alone do not verify the
panel's API connection or integrity. Preserve every SES ledger reservation when
moving consumers, and confirm a signed SNS delivery in the destination database.

The receiver token is held only in protected operator state. After rotating it,
update saved endpoints, configuration seeds, source callback and panel alert URLs.
Existing endpoints are preserved by reconciliation, not overwritten by deployment.
Check that the old URL returns 404 and the new authenticated GET returns 200;
a signed webhook ping verifies delivery without consuming an SES reservation.
Never print receiver URLs containing tokens.

## Local test composition

Requirements: Node 24+, Docker Compose, OpenSSL and a sibling Pro checkout with
installed dependencies. From the core checkout:

```sh
scripts/test-env.sh up
scripts/test-env.sh seed
scripts/test-env.sh status
scripts/test-env.sh invite all
# When finished:
scripts/test-env.sh down
```

`up` preserves existing data; `seed` is idempotent. `reset` destroys the disposable
composition and rebuilds its source snapshot. Use it after source changes. The
project is `mailstack-test`; its published addresses use loopback only:

| Surface | Address |
| --- | --- |
| API | `http://localhost:18880` |
| Panel | `https://localhost:18890` |
| Mailpit | `http://localhost:18825` |
| Playground | `http://localhost:18882` |
| Receiver | `https://localhost:18843/records` |

The API, panel and Mailpit use isolated fixture networks; port 8081 is never
published. Import the temporary content keyring in the browser; no panel server
holds it. Fixture credentials, invitations and immutable source SHAs are in the
0600 status file under `/private/tmp/mailstack-test-local`. Never include them in
reports. Use temporary headless browser profiles with distinct passkeys per role.
Enrollment alone does not satisfy step-up: perform an authentication assertion.

```sh
scripts/test-env.sh license expired
scripts/test-env.sh license valid
scripts/test-env.sh mode '{"hook":"500","ntfy":"timeout"}'
scripts/test-env.sh mode '{"hook":"200","ntfy":"200","license":"200","callback":"200"}'
scripts/test-env.sh logs
```

Receiver history contains exact bodies and selected diagnostic headers. Its seeded
secret verifies only the seeded endpoint; verify a panel-created endpoint with the
secret shown once at creation. Inspect actual Mailpit HTML/text and attachments
for first sends as well as repeats. Fixture SNS signatures and local licensing
are functional test evidence, not AWS/issuer integration evidence.

## Deployed profile tests

Use the [architecture table](architecture.md#profiles) and Stackpilot's
`apps/mailstack/README.md` for profiles a/b/c. Give each disposable installation a
distinct instance name and protected plan outside the checkout. Use `externalEgress`
only for profile (b), with signing entries added by the shared egress operator.
The installer has no plan dry-run; use its pure `readPlan` validator for local
inspection. Do not invoke installation merely to validate documentation.

Before any deployment, freeze core and Pro SHAs and validate the external config.
Worker updates use `npm run release`, not raw SQL migrations against an existing
schema. The production name `mailstack` has the production repository guard;
a different Worker name still requires clean checkouts. Record `/health.commit`
and `proCommit`, generated configuration digest and actual container image IDs.
Node images can report `commit: "dev"`; retain image/source evidence separately.

Deploy no listener ports in Pro Compose. Check Access on the panel, passkey login,
profile (a)'s `Internal` binding or profile (b)'s Access-protected internal host,
and egress readiness plus the persistent host firewall. The browser imports the
content keyring and displays sealed content in the sandboxed preview. Search,
export, erase and resend must work with the scoped internal client, never a full
send key mounted into the panel.

The API Worker has one minute cron and the panel Worker none. UTC minute 17 runs
only retention. A newly configured cron can take several minutes (up to 15) to
propagate. Accepted jobs and webhooks can stay pending during this interval.
Erase is asynchronous: wait for `done`, then confirm details are unavailable and
subject export contains no matching messages. Keep the cron running to finish
work across invocation budgets; an accepted request alone proves no completion.
See [background work](architecture.md#background-work-and-completion).

## Staging and manual scripts

The committed `scripts/staging/worker.sh` (`status`, `deploy`, `destroy`),
`scripts/staging/node.mjs`, `scripts/staging/ses.sh` and `scripts/test-worker.sh`
are test compositions using the private operator configuration above.
They refuse missing installation identities. Use Stackpilot plans for a new
installation and retain the selected identities and guards. `destroy`
removes data in the script's recorded scope. Keep the protected state needed for
identity checks, restoration and key continuity.

`scripts/test-worker.sh status` is local and reads only its status record. It
reports `RECORDED_NOT_LIVE_VERIFIED`; a missing record is a setup requirement,
not permission to deploy. The disposable Worker harness is separate from permanent
SES staging. It uses invalid SES credentials and cannot prove real delivery.
`scripts/staging/node-context.mjs <core> <pro> <new-context>` prepares an explicit
source context; configuration and secrets are supplied afterwards.

## SES and SNS testing

The SES resource script requires `MAILSTACK_STAGING_AWS_ACCOUNT_ID`,
`MAILSTACK_STAGING_SES_REGION`, `MAILSTACK_STAGING_SES_DOMAIN`,
`MAILSTACK_STAGING_SES_CONFIGURATION_SET`, `MAILSTACK_STAGING_EVENTS_URL`,
`MAILSTACK_STAGING_AWS_PROFILE`, `MAILSTACK_STAGING_AWS_CALLER_ARN`,
`MAILSTACK_STAGING_ZONE` and the production account/token-item settings above.
The caller ARN is checked before any mutation. Use your API's `/v1/events/ses`
URL; shared topics fan out to all subscribers and do not isolate delivery.
`scripts/staging/ses-policy.json` is an example: replace its account, region,
domain, sender and configuration-set with your own exact values before use.

Worker SES delivery (`MAILSTACK_STAGING_DELIVERY=ses`) requires the account, region,
configuration-set and `MAILSTACK_STAGING_FROM` sender. Supply isolated SES keys in
the environment; legacy custom-domain mode can instead use
`MAILSTACK_STAGING_SES_TOKEN_ITEM`. Set `MAILSTACK_STAGING_FROM` in the Node API
container environment too. This exact sender and the simulator recipient list
remain enforced by the budget adapter. Optional erasure-register setup also needs
`MAILSTACK_STAGING_B2_ENDPOINT` and `MAILSTACK_STAGING_B2_BUCKET`, in addition to its
existing B2 credentials and age recipient. Keep ledgers and keyrings intact.

Node HMAC maintenance requires `MAILSTACK_STAGING_NODE_HOST`,
`MAILSTACK_STAGING_NODE_STACK` and `MAILSTACK_STAGING_NODE_URL`. It verifies the
local hostname and Compose labels before operating. Hook/read tokens remain in
the environment. The manual Worker harness uses the configured production account
and token item for its fingerprint and isolated preview resources.

Use a dedicated SES identity, configuration set, signing key and IAM sending user
limited to the exact simulator addresses. Keep application delivery disabled until
that scope is verified. Configure `events.ses.topicArns`/`accountIds`, signature v2,
`SES_REGION` and `SES_CONFIGURATION_SET`; retain `masked` logging with `requireLog`.
Disable automatic contact confirmations. A confirmed SNS subscription alone is
not a delivery test; the API endpoint must receive the event for its own message.
Separate SQLite/D1 installations never share message rows through SNS fan-out.

| Recipient | Expected downstream outcome |
| --- | --- |
| `success@simulator.amazonses.com` | Delivery |
| `bounce@simulator.amazonses.com` | Bounce |
| `complaint@simulator.amazonses.com` | Complaint |
| `suppressionlist@simulator.amazonses.com` | Bounce |

The staging SES adapter has persistent recipient budgets. Defaults are 100 per
rolling 24 hours and 20 per rolling hour; a two-installation test should allocate
50/day and 10/hour to each. Worker inputs are `MAILSTACK_STAGING_SES_DAY` and
`MAILSTACK_STAGING_SES_HOUR`; Node inputs are `STAGING_SES_DAY` and
`STAGING_SES_HOUR`. Preserve the dedicated D1 ledger and Node
`/data/staging-ses-budget.db` across restarts. Every attempted provider call consumes
its reservation even on refusal or an uncertain result. Rejection returns
`429 staging_ses_limit`; unavailable budget storage returns
`503 staging_ses_store_unavailable`. Never reset ledgers or move rejected traffic
to another installation to gain quota. Recreate a Node container to change its
environment. These guards belong to the staging composition, not the product.

The Pro AWS page sends three paced simulator messages through the API's provider.
Record their core IDs and downstream SNS timelines. SES acceptance or SMTP relay
acceptance does not establish Delivery/Bounce/Complaint. Use Mailpit separately
to inspect MIME: the SES simulator provides no readable inbox. Provider charges
and sending-rate limits still apply; billing alerts are not synchronous send caps.

## Sellf webhook event selection

Use only supported events from the [event table](../README.md#sellf-event-contract).
Purchase/refund mail needs `purchase.completed` and `refund.issued`; license keys
also need `license.issued` and a hook client permitted to use `license`.
Permit `bank-transfer`, `notice` and `welcome` for the corresponding optional flows.
Explicit source registries must be updated from `docs/sources/sellf.json`.
Mailstack does not enforce cross-event ordering or business consistency.
Do not enable both lead/access notifications unless both emails are desired.
Unsupported events return `422 unsupported_event`; retrying does not add support.

Keep pending-retry identity changes separate from fresh fixtures: older `sellf:`
keys do not match `source:` keys, and purchase UUID identity differs from earlier
PI/CS identity. Do not edit saved producer payloads to manufacture missing data.
A mapped event missing required output must fail before a provider call.

## Manual test entry conditions and cleanup

Record versions, configuration hashes, licensing state, client selections, delivery
mode/budgets, Access readiness, egress readiness, verified register and available
browser credentials before starting. Check every enabled profile using its own
store. Include first send, duplicate, refused/uncertain send, first notification
and confirmation, search after navigation, form validation followed by correction,
webhook retry, resend, backup/restore and completed erasure.

For a restore test, use a new isolated database and the full B2 register procedure
in [backup.md](backup.md); restore the panel separately and reset sessions. Pro's
README documents profile (a)'s temporary internal route. Keep restored public send
and event ingress quarantined until later erasures have completed.

Stop only the disposable Compose project; use the documented Stackpilot uninstall
for plan-managed resources. It retains local keys/state and B2 copies/register.
A shared egress and its firewall belong to its operator: remove only the retired
installation's signing entries and dedicated token. Remove temporary databases,
service tokens and Access policies by their recorded identity; preserve all keys
still needed for backups and every numbered register entry. Do not use host-wide
Docker cleanup or delete a shared Mailpit history. Retain private test evidence
without credentials; a finished test report is not deployment authorization.
