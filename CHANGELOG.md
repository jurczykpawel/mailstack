# Changelog

All notable changes to mailstack are documented here.

## [Unreleased]

- Replace the Sellf adapter with the configurable source preset in
  `docs/sources/sellf.json`, installed by default when `sources` is omitted.
- Preserve valid email content and purchase licenses with closed `first`, `format`
  and `purchase-licenses` operations; minor units render with a decimal dot.
- Retain the Sellf adapter's amount rounding and runtime timezone for purchase dates.
- Limit webhook data validation to recipient and template requirements. Sellf owns
  refund status, cumulative totals, full/partial consistency and currency rules.
  Enable only supported Sellf events; purchase/refund flows need
  `purchase.completed` and `refund.issued`.
- Source idempotency keys use a new `source:` namespace with brand/client scope;
  older adapter keys are not matched. Reconcile outstanding deliveries on upgrade.
- Breaking (panel): the internal API moves to `/internal/v2/*` with assertion v2
  (`PANEL_ASSERTION_KEYS` keyring, token and audience binding, single-use nonce for
  mutations, `X-Panel-Protocol: 2`); `/internal/v1/*` and `PANEL_ASSERTION_KEY` are removed.
  Node needs `PANEL_AUDIENCE`. Upgrade the panel together with the API.

## [1.0.0] - 2026-06-10

### Added

- **Multi-brand routing**: resolve tenant from `?brand=` query param or request `Origin`
  header; each brand has its own SES sender, fixed recipient, origin allowlist, and
  visual theme.
- **Anti-relay enforcement**: recipient (`brand.to`) is always server-side; body `to`/`from`
  are ignored in public mode — the endpoint cannot be used as an open relay.
- **Public mode**: Origin allowlist + Cloudflare Turnstile (verified server-side) +
  honeypot + KV fixed-window rate limiter (8 req/hour per brand+IP).
- **Trusted mode**: `Authorization: Bearer <API_KEY>` (constant-time compare) bypasses
  browser checks and allows `template`, `subject`, `to`, `replyTo` overrides.
- **Template system**: shared branded layout (header band + footer) with five types —
  `contact` (public), `welcome`, `received`, `payment`, `notice`. All values
  HTML-escaped; custom types can be added by implementing `TemplateDef`.
- **Auto-reply**: optional per-brand (`brand.autoReply`) or per-request (`autoreply` key)
  confirmation email back to the submitter, dispatched non-blocking via `ctx.waitUntil`.
- **Sellf webhook adapter** (`POST /v1/hooks/sellf`): maps Sellf e-commerce events
  (`purchase.completed`, `refund.issued`, `waitlist.signup`, `lead.captured`,
  `access.expired`) to branded transactional emails; unmapped events and missing/invalid
  recipients are acked (200) without sending.
- **Logo asset endpoint** (`GET /brand/logo.png`): serves the brand logo PNG (base64
  in `src/assets/logo.ts`) with long-lived cache headers.
- **Config split**: gitignored real config (`src/brands.ts`, `wrangler.toml`,
  `src/assets/logo.ts`) with committed `.example` templates and an
  `npm run setup` script to bootstrap fresh clones.
- **TruffleHog secret scanning**: pre-commit hook (skips gracefully if not installed)
  and CI workflow gate.
- **CI**: GitHub Actions workflow — `npm ci` + setup + typecheck + test on Node 22.
- **Dependabot**: weekly updates for npm and GitHub Actions (semver-major ignored).
