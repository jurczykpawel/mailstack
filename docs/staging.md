# Staging

Use synthetic `acme`/`demo` brands and a separate installation, database, hostnames,
keys and register prefix. Infrastructure addresses, account inventories, credentials
and live version records belong in private operator state, not this document.
Do not infer a deployed version or available quota from a repository report.

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

## Existing maintainer scripts

The committed `scripts/staging/worker.sh` (`status`, `deploy`, `destroy`),
`scripts/staging/node.mjs`, `scripts/staging/ses.sh` and `scripts/test-worker.sh`
are maintainer compositions with installation-specific constants and credential
lookups. They are not general-purpose installers. Read their pinned identities
and guards before use; use Stackpilot plans for a new installation. `destroy`
removes data in the script's recorded scope. Keep the protected state needed for
identity checks, restoration and key continuity.

`scripts/test-worker.sh status` is local and reads only its status record. It
reports `RECORDED_NOT_LIVE_VERIFIED`; a missing record is a setup requirement,
not permission to deploy. The disposable Worker harness is separate from permanent
SES staging. It uses invalid SES credentials and cannot prove real delivery.
`scripts/staging/node-context.mjs <core> <pro> <new-context>` prepares an explicit
source context; configuration and secrets are supplied afterwards.

## SES and SNS testing

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
