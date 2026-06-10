# Contributing

## Dev setup

```bash
git clone <repo>
cd mailstack
npm install          # also runs `prepare` which initializes husky
npm run setup        # generates wrangler.toml from .env + copies brand/logo examples
```

Now copy `.env.example` to `.env` and fill in your KV ids (+ optional custom domain), then
edit `src/brands.ts` with at least one brand (the example has `acme` and `demo`).

For local dev, copy `.dev.vars.example` to `.dev.vars` and fill in the secrets:

```bash
cp .dev.vars.example .dev.vars
$EDITOR .dev.vars
npm run dev
```

## How config works

Deployment config is generated (gitignored), so nothing private is committed:

| Generated file | Created from |
|---|---|
| `wrangler.toml` | `wrangler.template.toml` + `.env` (`MAILSTACK_*` vars) |
| `src/brands.ts` | `src/brands.example.ts` |
| `src/assets/logo.ts` | `src/assets/logo.example.ts` |

Configure via `.env` (KV ids + domain) and `src/brands.ts` — not the generated files.

`npm run setup` (also runs automatically before `dev`, `test`, `typecheck`, `deploy`)
copies each example to the real location if the real file is absent. Never edit the
`.example` files with real data — they are committed as-is and serve as the public
template.

## Running tests

```bash
npm test          # runs ensure-config then vitest
npm run typecheck # type-check only (no emit)
```

Tests use demo brands (`acme`, `demo`) from `src/brands.example.ts` on a clean clone.
All side effects (SES send, Turnstile verify, clock) are injected via `SendDeps` and
mocked in tests — no real AWS or Cloudflare calls are made.

## Adding a brand

1. Add an entry to `src/brands.ts` (gitignored; do NOT edit `brands.example.ts`).
2. Add a case to `test/brands.test.ts` if you want to assert specific field values.
3. `npm run typecheck && npm test`.
4. Redeploy.

## Adding a template type

1. Create `src/templates/types/<id>.ts` exporting a `TemplateDef` (`id`, `subject`,
   `render`). Use shared helpers from `../layout` (`escapeHtml`, `paragraph`,
   `summaryTable`, `ctaButton`/`ctaText`) for consistent brand chrome.
2. Register it in `src/templates/index.ts`.
3. Set `publicAllowed: true` only if the type is safe for unauthenticated browser use
   (only `contact` should be).
4. Add tests in `test/template-types.test.ts`.

## Adding a Sellf event mapping

1. Add an entry to `SELLF_EVENT_MAP` in `src/sellf.ts`: a function
   `(envelope) => { template, to, data, subject? } | null`.
2. Add a test case in `test/sellf-hook.test.ts`.
3. No other wiring needed.

## PR expectations

- All tests must pass (`npm test`).
- TypeScript must compile cleanly (`npm run typecheck`).
- No real brand data, real emails, or real domain names in committed files — use
  `*.example` domains (e.g. `acme.example`, `demo.example`, `example.com`).
- The pre-commit hook runs TruffleHog against staged files. If it blocks your commit,
  check for accidentally staged secrets.

## Pre-commit secret scan

Install TruffleHog locally for best results:

```bash
brew install trufflehog
```

The hook runs automatically on `git commit`. If `trufflehog` is not installed it will
warn and continue (CI still enforces the scan).
