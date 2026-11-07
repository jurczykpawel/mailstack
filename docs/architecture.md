# Architecture and deployment profiles

Mailstack renders configured email and sends it through SES or SMTP. Callers own
business decisions, event ordering and subscription selection. Mailstack validates
the recipient and data needed to render, authenticates requests, applies public-form
guards and deduplicates retries of the same request. It does not coordinate events
from another system. See the [Sellf contract](../README.md#sellf-event-contract).

## Profiles

The table describes installations with Mailstack Pro. The MIT core also runs alone
as an API Worker or Node service, without the panel or Pro outbound features.

| Component | (a) API and panel on Cloudflare | (b) Mixed | (c) API and panel on a VPS |
| --- | --- | --- | --- |
| Sending API | Worker, SES | Worker, SES | Node 24+, SES or SMTP |
| Delivery log and job state | API D1 | API D1 | API SQLite |
| Pro operator panel | Separate Worker and panel D1 | Node process/container and panel SQLite | Node process/container and panel SQLite |
| Panel to API | Service binding to `Internal` in `src/worker.ts` | HTTPS internal hostname behind Access, with service credentials | Private listener `api:8081` |
| Public panel access | Custom domain behind Access, then passkey | Tunnel + Access, then passkey | Tunnel + Access, then passkey |
| Outbound webhook/source callbacks | VPS egress via Tunnel + Access + host firewall | VPS egress via Tunnel + Access + host firewall; may be shared | Node transport in the API |
| Server services in Pro Compose | `cloudflared`, `egress`, `backup` | `panel`, `cloudflared`, `egress`, `backup` | `api`, `panel`, `cloudflared`, `backup` |
| Background work | One API minute cron; no panel cron | One API minute cron; Node panel maintenance | API job clock every second; hourly retention |
| Daily offsite copy | API and panel D1 exported separately | API D1 export; panel SQLite backed up separately | API SQLite snapshot; panel SQLite backed up separately |
| Cloudflare dependency | Workers, D1, DNS, Access, Tunnel | Workers, D1, DNS, Access, Tunnel | DNS, Access, Tunnel for this composition; no Worker or D1 |

“All on Cloudflare” describes the API and panel in profile (a). It still needs a
server for egress and offsite copies. “All on a VPS” describes compute and databases
in profile (c); the supplied ingress still uses Cloudflare Tunnel and Access.
There is no Cloudflare Container dependency. A core-only Node deployment can use a
different reverse proxy; configure its trusted-proxy setting explicitly.

Use the [core Worker setup](../README.md#worker-setup--step-by-step),
[core Docker setup](../README.md#run-with-docker-node--sqlite), and the Pro README
for the panel. Stackpilot's `apps/mailstack/README.md` documents automated profiles,
secret references, `externalEgress` (profile b only), updates and uninstall.

## Requirements and Workers Free

All profiles need a validated external configuration, provider credentials and a
verified sender; public forms also need their configured captcha. Pro adds a valid
license, a scoped panel client, assertion/transit keyrings, an Access identity policy
and browser passkeys. Erasure requires an initialized B2 register. Keep content and
backup private keys offline; see [backup.md](backup.md).

Workers Free is a supported configuration choice, subject to provider limits; it
is not a blanket capacity guarantee for either the API or panel. As checked on
2026-11-07, Cloudflare documents **10 ms CPU per HTTP request and per cron invocation**,
100,000 requests/day and **five Cron Triggers per account**. Mailstack uses one;
staging and other applications consume the same account allocation. The minute
trigger does not acquire an hourly CPU allowance just because one branch runs hourly.
See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

D1 Free allows 50 queries per Worker invocation, 500 MB per database and 5 GB total.
API and panel use separate databases, but account storage and daily read/write
allowances are shared with all other D1 applications: 5 million rows read and
100,000 rows written/day. Index writes also count. Exhausting a Free daily allowance
causes query errors until it resets. See [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

Set `"cloudflare": {"plan":"free"}` in the API configuration when using Free;
the value informs the API operation budget and reported provider
backup window; it does not change your Cloudflare subscription or disable Pro
features. The API uses a 40-operation budget on Free and 990 only with explicit `paid`.
Omission reports the Paid backup window but still uses the conservative 40-operation
budget; set the intended plan explicitly. The Worker
panel bounds audit verification and stores checkpoints so a long chain can advance
across requests. These bounds do not prove CPU compliance. Measure the actual
configuration, payload sizes, passkeys and background workload before rollout.
The Node panel in profile (b) avoids panel Worker CPU limits; its API still uses D1.

## Background work and completion

The API Worker declares exactly `* * * * *`. At UTC minute 17 it runs retention
only; all other minutes run jobs, durable event fan-out and extension delivery
queues. The panel Worker declares no cron. Accepted work may also start in
`waitUntil` after an HTTP response. Creating an erase job returns `202`, not a
completed deletion. Poll its job status until `done` and check the result.

Keep the API cron enabled to finish erase jobs and other work across invocation
budgets and retries. An individual request may advance or even finish a small job;
it does not guarantee completion. Scheduling, operation budgets, extension
readiness and retry delays can add several minutes. New or changed cron settings
can take up to 15 minutes to propagate; see
[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
A successful `/health` does not prove that cron or B2 is working.

Jobs use persisted cursors, a 30-second lease and bounded work per invocation.
Erase precedes other core jobs. Failed attempts back off for 1 minute, 10 minutes,
1 hour and 6 hours; the fifth failure is terminal. Missing extension readiness can
leave work pending without consuming an attempt. The job alarm reports due work
older than 15 minutes, at most once per hour. Node drains jobs every second and
uses the cron budget/alarm once a minute; retention starts after 30 seconds, then
hourly. None of these timers is an email campaign scheduler.

## Data and key boundaries

| Location | Data and keys |
| --- | --- |
| API | Provider credentials, public content keys, index keys, transit private keys, assertion keyring, log database and Pro endpoint keys |
| Panel server/Worker | Sessions, users, passkeys, audit checkpoints, scoped API token, assertion keyring, license state; no content private key, API database or provider credentials |
| Operator browser | Imported content private keyring; opens sealed subjects, addresses, archives and evidence locally |
| Backup host | Encrypted database values plus metadata during export; public age recipient and upload credentials; no age identity or content private key |
| Owner's recovery computer | Offline content keyrings, backup age identity, retained configuration and key generations |

The API necessarily receives plaintext for a new send and opens transit envelopes
for requested operations. The panel forwards sealed data and transit envelopes.
**Archived email is decrypted only in the browser during panel use.** The offline
`log show` utility and backup restore command run on the owner's computer; they
are separate recovery tools, not server decryption paths. Never mount private
content keys into either service. The panel refuses `PANEL_CONTENT_KEYS_FILE`.

Archives retain the projection selected at send time (`masked` or `full`), not
necessarily the complete delivered MIME. Attachments are sent but are not archived
or restored by resend. A provider acceptance means `sent`, not recipient delivery;
SES/SNS events provide downstream outcomes. SMTP alone records relay acceptance.

## Network and egress

Production Pro Compose publishes no host ports. Profile (a) uses a service binding
for the panel and needs no permanent API internal hostname. Profile (b) uses an
internal hostname with Access service authentication and API-side Access JWT
verification. Both retain the scoped token and assertion-v2 checks. Profile (c)
keeps port 8081 on the private container network. See [internal-api.md](internal-api.md).

Worker webhook and source-resend requests use `EGRESS_URL`, `EGRESS_KEYS`,
`EGRESS_ACCESS_CLIENT_ID` and `EGRESS_ACCESS_CLIENT_SECRET`. Without the complete
configuration those features report `platform:secure_egress_unavailable`.
The egress host is a separate Tunnel hostname guarded by a Service Auth policy.
The egress verifies signed orders and uses the Node transport. Its host firewall
must be installed before starting it and retained across Docker/host restarts.
Configure public host addresses in `EGRESS_DENY_CIDRS` and the egress host's zone in
`EGRESS_DENY_ZONES`; that zone must host no webhook receivers. The Pro README
contains the firewall installation and readiness checks.

A shared egress retains independent signing entries per installation. Stackpilot
`externalEgress` provisions no shared egress resources and removes none on uninstall;
the egress operator adds/removes the installation's signing entries and any dedicated
Access token. Keep the owner stack running while dependents use it.

## Schema upgrades and recovery

Worker releases use `npm run release`: repository guard, setup from the external
configuration, migration manifest validation, shared schema upgrade, manifest
recheck, then deployment and optional health SHA verification. `npm run migrate:worker`
runs that upgrade separately after setup; it is remote and has no dry-run flag.
Do not substitute raw migration application for upgrades of existing databases.
Node applies the shared migrations before listening. Upgrade core and Pro together
for assertion v2 and compatible extension schemas. See [release commands](../README.md#updating-it-later).

Erasure first publishes an age-encrypted entry and confirmed head in the independent
B2 register, then hides/deletes the selected records. Retain genesis, head and every
numbered entry, outside database-backup lifecycle rules. Restore into an isolated
new database, validate the complete register and reapply erasures before reopening
traffic. Panel state is restored separately, with sessions reset and later user/role
changes reapplied. Profile (a) recovery uses a temporary Access-protected internal
route from the owner's computer. Full procedures are in [backup.md](backup.md) and
the Pro README; neither a restored API nor panel database proves register completeness.
