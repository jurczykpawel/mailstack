# Internal API

Node serves these routes through the existing internal listener on port 8081.
The public listener does not mount them. The Cloudflare Worker serves only
`/internal/v1/*` (no extension routes), and only on `INTERNAL_HOST`: set
`MAILSTACK_INTERNAL_ROUTE` in `.env` (a second custom domain; `npm run setup`
also turns off `workers.dev` and preview URLs) and the `PANEL_ASSERTION_KEY`
secret. Panel clients come from Mailstack Pro keys. Every other host, or a
missing key, returns 404. Put the host behind Cloudflare Access with a service
token; the panel sends it from `PANEL_API_ACCESS_ID_FILE` / `PANEL_API_ACCESS_SECRET_FILE`.
Both runtimes use the same `authorizePanel` gate in `src/core/panel.ts`. The API returns sealed values; only the
panel holds private content keys. Responses use `Cache-Control: no-store`.

## Credentials and panel assertions

Every call requires the existing `Authorization: Bearer <client token>` with
`panel` scope and `X-Panel-Actor`. Invalid credentials return 401; missing scope,
actor, assertion, role or step-up returns 403. Brand and template selections apply
to every message read, search, export and erase. Empty selections grant no access;
use explicit `"*"` for all. A message outside the selections returns 404.

The panel and API share `PANEL_ASSERTION_KEY`: a random 32-byte base64url value,
separate from content/index keys and client tokens. Without it calls are denied.
`signPanelAssertion(request, claims, key)` from `src/core/panel.ts` produces the
`X-Panel-Assertion` header. The panel supplies claims from its verified session:

```ts
{ actor: 'user-1', role: 'operator', issuedAt: now,
  expiresAt: now + 60_000, stepUpAt: now }
```

Times are epoch milliseconds. The maximum assertion TTL is 60 seconds; future
issue times and elapsed expiry are refused. `stepUpAt` is null without a completed
step-up, otherwise the time of the verified WebAuthn assertion. Sensitive actions
require it within the last five minutes. The API verifies the HMAC, actor equality,
role, times and SHA-256 operation binding over
`method + '\n' + pathname + search + '\n' + exactBody` before routing.
Create a new assertion for each operation, after serializing its body and query.
Hosts are excluded so the same contract works through a local proxy. The signing
key is held by the session service, never sent to a browser. Session revocation and
role changes must stop assertion issuance; an already issued assertion can remain
valid for at most 60 seconds. The core does not authenticate passkeys or sessions.

Extension handlers receive the verified principal as `ctx.panel`, including client
scopes and selections. Event hooks receive no panel principal. P2/P6/P8 can use
`panelAllows` for the common role/step-up check; extensions must also check their
specific scope and apply the principal's selections to their own queries/mutations.
A webhook configuration client may have `panel,webhooks:write`; panel remains
separate from send/hook clients. `webhooks:write` alone grants neither panel access
nor read/send permissions. Mailstack Pro (`src/keys.ts`, `scripts/client.ts create --scopes`) accepts it;
webhook routes and behavior belong to the extension.

## Roles and operations

| Operation | Role | Step-up | Audit before returning sealed data or mutation |
| --- | --- | --- | --- |
| List / search | viewer | no | `log.list` / `log.search` |
| Detail / sealed recipients / timeline | viewer | no | `log.read` |
| Content | operator | yes | `content.read` |
| Evidence | operator | yes | `evidence.export` |
| Resend source | operator | yes | `resend.source` |
| Subject export / erase | admin | yes | `privacy.export` / `privacy.erase` |
| Audit rows / head | viewer | no | none |
| Panel login / logout / integrity alarm append | viewer | no | the appended entry |
| Panel role / user changes append | admin | yes | the appended entry |

Higher roles include lower roles. Lists and details include sealed subjects or
addresses, so they also require completed audit writes. An audit failure returns
503 without data or mutation. Audit rows/head/append require wildcard brand and
template selections: the global chain cannot be filtered without losing chain
verification or disclosing another selection's entries.

## Routes and response shapes

- `GET /internal/v1/messages`: `{messages, cursor}`. List projection: `id`, `brand`,
  `template`, `level`, `status`, `created_at`, `sent_at`, `addr_hints`, `subject_sealed`.
  Optional exact `brand`, `template`, `status`, `rcpt` and `ref`; inclusive epoch-ms
  `from` / `to`; `limit` 1–100 (default 50). Cursor is opaque base64 JSON over
  `[created_at, id]`, descending with an ID tiebreaker; reuse the same filters on
  subsequent pages. Invalid bounds/cursor return 400. Search covers all active
  index keys, including the recipient's index kid. Search terms never enter audit.
- `GET /internal/v1/messages/:id`: metadata, sealed subject, sealed `recipients`
  and chronological `events` without evidence. Internal indexes/MACs are omitted.
- `GET /internal/v1/messages/:id/content`: `{sealed, expires_at, level}` or 404.
- `GET /internal/v1/messages/:id/evidence`: `{events, provider_response_sealed}`;
  events contain only `id` and `evidence_sealed`.
- `GET /internal/v1/messages/:id/resend-source`: `{id, brand, template,
  ref_sealed, replay}`; replay is `{sealed, expires_at}` or null. No MAC, index or
  signing/sending key is returned. This route prepares the panel-side read only;
  resend execution remains a separate task.
- `POST /internal/v1/subjects/export` `{email, limit?, cursor?}`: `{messages, cursor}`, each with metadata,
  recipients, timeline, sealed content/replay/ref and an `evidence` object
  containing sealed provider response and event evidence. All subject
  roles match: recipient, reply_to, submitter. Limit is an integer 1–50 (default
  25); each page is audited before returning data. Pass the returned opaque cursor
  with the same email on the next request until cursor is null. Pages use ascending
  message ID order, read at most limit + 1 messages and load their data sequentially.
  Each response buffers only one page; clients must collect all pages to complete
  an export. This is a live view: concurrent erasure/expiry may remove records and
  new messages may appear on later pages.
- `POST /internal/v1/subjects/erase` `{email, reason}`: `{count}`. Reason is required
  (10–500 characters) but not persisted. Audit keeps only matched count and an
  eight-character index prefix. Deletes include expired messages and explicitly
  remove every child table in atomic batches of at most 50 messages. Batch failure
  returns 503; earlier completed batches remain erased, so retry is safe.
  [Extension cleanup](extension-privacy.md) completes for all selected messages
  before core deletion begins; a cleanup error or deadline returns 503 without
  deleting core messages or children. Late SES
  events and SMTP completion cannot recreate deleted messages or children. Backups expire independently.
- `GET /internal/v1/audit?after_seq&limit`: `{rows}`, ascending seq, limit 1–500
  (default 100), after_seq nonnegative (default 0).
- `GET /internal/v1/audit/head`: `{seq, hash}`, genesis `{seq:0, hash:64 zeros}`.
- `POST /internal/v1/audit`: `{action, target?, details?}` → appended audit row.
  Actions: `panel.login`, `panel.logout`, `panel.integrity.alarm`,
  `panel.role.changed`, `panel.user.invited`, `panel.user.removed`. Optional target
  is `msg_<id>` or `user:<id>` with 1–128 alphanumeric/underscore/hyphen characters.
  Details allow only nonnegative integer `count`/`seq`, lowercase SHA-256 `hash`,
  and a valid `role`. Arbitrary context is refused to keep PII out of the chain.

Missing/expired records and content return 404 before maintenance runs. Metadata
and content ceilings from the current config also apply. Export omits expired
archives and replay payloads. Provider responses and event evidence follow metadata
retention, independently of archive expiry, both in evidence reads and subject
exports. A source read can still return a retained sealed ref.
Requests have a 64 KiB body limit and an 8 KiB URL limit. No route decrypts history.

## Extension domain events

`Extension.onEvent(event, ctx)` receives the `DomainEvent` contract from
`src/core/extensions.ts`. `EmitEvent` accepts the same fields except `id`, which
Node assigns once per event before passing it to extensions.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | nonempty opaque string | Event identity; separate events have separate IDs. |
| `messageId` | nonempty opaque string | Message identity, stable across events for the same delivery attempt. |
| `type` | string union | `message.sent`, `message.send_failed`, `message.unknown`, `message.delivered`, `message.bounced`, `message.complained`, or `form.submitted`. |
| `at` | number | Event emission time, epoch milliseconds. |
| `brand`, `template` | string | Configured brand and template IDs. |
| `status` | string | Recorded delivery state, or the attempt outcome when unrecorded. |
| `ref` | optional string | Independent caller correlation; never required for message correlation. |

For recorded sends, `messageId` equals `messages.id` and the trusted send/hook
response `id`. SES events retain that ID, including when Bounce precedes Delivery;
`type` describes the event while `status` reflects the current projection. Neither
an event ID nor a provider's `MessageId` is a substitute for the domain message ID.
Two messages without `ref` have different message IDs. Core events contain no
recipient addresses, subjects or message content. Treat the optional caller-supplied
`ref` according to the extension's disclosure policy.

At logging level `none`, or when optional logging is unavailable, the pipeline
creates one ephemeral message ID for each actual send attempt. It writes no message
row or content for that ID. The send outcome and a successful public
`form.submitted` share it; an auto-reply is a separate attempt with its own ID.
The internal result field `correlationId` carries this value to the form handler;
`deliveryResponse` never exposes it. Public and unrecorded API responses remain
unchanged. A `none` guard does not retain this ID, and later SNS events cannot
recover it without a message row. Deduplication emits no new send event or attempt
ID. A refusal before sending due to required logging emits no mail event.

For SMTP, `message.sent` means acceptance by the configured relay, not confirmed
recipient delivery. Extension consumers must preserve `messageId` when forwarding
an event and use `id` independently to deduplicate that event.
