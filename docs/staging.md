# Staging

These installations use synthetic acme/demo data. Never enter customer data or use real recipients. Credentials are stored in the Infra collection in Vaultwarden under `Mailstack staging Worker` and `Mailstack staging Node`; they are not in this repository.

| Installation | URL | Delivery |
| --- | --- | --- |
| Worker + dedicated D1 | https://mailstack-test.techskills.academy | Disabled: the staging adapter returns `503 delivery_disabled` after the shared pipeline records an unsuccessful attempt. No SES credentials are installed. |
| Node + Pro panel | https://mailstack-test.tojest.dev | Authenticated SMTP with STARTTLS to the shared test Mailpit; no relay to real inboxes. SMTP connects to the Docker host gateway IP with `SMTP_TLS_SERVERNAME` set to the Mailpit certificate hostname. |
| Mailpit inbox | https://mailpit.automagicznie.pl | UI/API credentials are in `Sellf TEST Mailpit`. Filter by your unique subject; do not delete other projects' messages. |

The Node URL serves the panel at `/` and the API at `/v1/*`, `/altcha/*`, `/brand/*` and `/health`. Panel passkeys require an invitation; shell access to the installation creates it. API health does not establish panel health: inspect the separate panel container too.

## Worker operations

Use the `staging/st1` core worktree with dependencies installed. Select the account explicitly. Load the Cloudflare token from your secret manager into `CLOUDFLARE_API_TOKEN`, or use the unlocked agent Vaultwarden CLI. Do not put tokens in command arguments.

```sh
export CLOUDFLARE_ACCOUNT_ID='<account-id>'
scripts/staging/worker.sh status
scripts/staging/worker.sh deploy
```

State defaults to `~/.config/mailstack-staging/worker` (directory 0700, files 0600). `MAILSTACK_STAGING_STATE` selects another directory outside the source checkout. Keep `secrets.json`, `content-private.json` and `resources.json` together; do not regenerate keys for an existing database. Each Cloudflare write is surrounded by reads of production deployments; a changed fingerprint stops the script. Resource names and the custom domain are fixed. The script never changes subscriptions, production resources or AWS.

Deployment uses a recorded immutable commit from `main`; application sources are extracted from that commit into protected state before bundling. To select a newer main commit, explicitly set `MAILSTACK_STAGING_COMMIT` to that commit. The standalone staging composition supplies configuration, synthetic license endpoints and a disabled delivery adapter. It does not change the core sender.

The cron runs retention at minute 17 of each hour. Content retention is one day, metadata seven days. A full destructive Worker reset is:

```sh
scripts/staging/worker.sh destroy
scripts/staging/worker.sh deploy
```

This removes only the recorded staging domain, Worker and D1, then recreates them with the retained keys. Destroy is repeatable. It permanently removes staging messages. Keep the local state for the resource identity check and preserve its credentials in Vaultwarden.

Trusted synthetic send: read `SEND_TOKEN` from the protected state into a local environment variable and send bearer auth through a client that does not log headers. The scoped client permits `brand=acme`, `template=notice`, with the fixed synthetic recipient. Expect `503 delivery_disabled`. Public ALTCHA submissions also reach the disabled adapter after verification. The Sellf hook uses `HOOK_TOKEN` plus `SELLF_STAGING_HMAC`; sign the exact JSON bytes as HMAC-SHA256 over `<unix-seconds>.<body>` and send `X-Sellf-Signature: t=<unix-seconds>,v1=<hex>`.

No SNS delivery loop is available until the separate SES work is approved and installed. The disabled-send response intentionally contains no message ID; administrators can inspect the staging D1 message rows. A provider event timeline remains empty until a provider event exists.

## Node operations

The installation is on the test Mikrus `piotr293`, SSH alias `piotr`, under `/opt/stacks/mailstack-staging`. The dedicated installer checkout is `/opt/stackpilot-st1`; its changes are local and unmerged. Source images are built from `/opt/mailstack-staging-context-final`, with no registry publication.

Redeploy on the server through Stackpilot:

```sh
cd /opt/stackpilot-st1
MAILSTACK_ROLE=panel \
MAILSTACK_LICENSE_OPTIONS_FILE=/opt/mailstack-staging-license.json \
PANEL_ORIGIN=https://mailstack-test.tojest.dev \
MAILSTACK_PRO_CONTEXT=/opt/mailstack-staging-context-final \
MAILSTACK_PRO_API_IMAGE=mailstack-staging-api:st1 \
MAILSTACK_PRO_PANEL_IMAGE=mailstack-staging-panel:st1 \
STACK_DIR=/opt/stacks/mailstack-staging PORT=3410 MAILSTACK_BIND_MODE=public \
./local/deploy.sh mailstack --domain-type=local --yes
```

Use `local` when redeploying an already registered Cytrus name; do not register it again. The first deployment uses `--domain-type=cytrus --domain=mailstack-test.tojest.dev`. The explicit `MAILSTACK_BIND_MODE=public` retains port 3410 on all interfaces and its existing firewall allowance when using local mode on redeploy. Check the published port after every change of domain mode.

The panel uses a signed test fixture compatible with the Pro verifier, rather than a purchased license. Its public keys and empty revocation buckets are served at the Worker staging's `/_staging/jwks` and `/_staging/revoked` paths. The signing private key stays outside the repository. This license expires after one year; renew it before expiry. These endpoints are exclusively for staging, not a commercial license issuer. The normal verifier checks the signature, product, host, expiry and revocation data. Cold starts require the Worker endpoints; the normal offline grace applies after confirmation.

There are two credentials for commercial Pro: a registry access token to download private images and a Sellf-signed license to enable features. The fixture/source-build staging requires no registry token. The installer defaults to `MAILSTACK_ROLE=core`, which requires neither credential; legacy `full` maps to `core`. `panel` without a key stops and explains the missing input.

The API receives only public content keys and its own delivery/index/assertion/webhook keys. The panel receives private content keys and a scoped internal token, with a separate SQLite database. Port 8081 is private to the Compose network. Port 3410 reaches a gateway that talks to the panel over its private TLS connection. External HTTPS is provided by Cytrus.

```sh
cd /opt/stacks/mailstack-staging
sudo docker compose ps
sudo docker compose exec panel node dist/panel.mjs invite --role admin
```

Invitations are private, single-use and valid for fifteen minutes. Browser passkey enrollment is performed by the tester. No enrollment is necessary for the API/Mailpit smoke test.

Use a unique subject such as `ST1-<timestamp>` for each synthetic send. Load the staging API credential from Vaultwarden; do not copy `.env` into a ticket or command history. Query the individual Mailpit message to confirm its subject and recipient. Panel log details and timeline use the scoped internal API, so tests can validate them without adding a browser user.

For a data reset, stop only this Compose project. Preserve `.env`, `config`, `secrets`, the license and backups separately. Remove the staging API/panel SQLite files and backups only while stopped, then rerun the installer; this also removes panel users and requires new invitations. Do not run host-wide Docker cleanup or remove the shared Mailpit data. SMTP configuration remains limited to the test Mailpit.

Alerts have a loopback placeholder and send no external notifications. Replace `PANEL_NTFY_URL` only when intentionally testing alerts. Replace the panel's private TLS certificate pair before its one-year expiry. Do not use this fixture installation for production traffic.
