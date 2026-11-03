# Staging

These installations use synthetic acme/demo data. Never enter customer data or use real recipients. Credentials are stored in the Infra collection in Vaultwarden under `Mailstack staging Worker` and `Mailstack staging Node`; they are not in this repository.

| Installation | URL | Delivery |
| --- | --- | --- |
| Worker + dedicated D1 | https://mailstack-test.techskills.academy | SES simulator only, persistent staging budget: 50 recipients/day and 10/hour. The deployment script defaults to disabled unless SES is explicitly selected. |
| Node + Pro panel | https://mailstack-test.tojest.dev | SES simulator only, Pro AW2 and resend enabled; separate persistent budget: 50 recipients/day and 10/hour. |
| Mailpit inbox | https://mailpit.automagicznie.pl | UI/API credentials are in `Sellf TEST Mailpit`. Filter by your unique subject; do not delete other projects' messages. |

The Node URL serves the panel at `/` and the API at `/v1/*`, `/altcha/*`, `/brand/*` and `/health`. Panel passkeys require an invitation; shell access to the installation creates it. API health does not establish panel health: inspect the separate panel container too.

## Worker operations

Use a clean core checkout containing the staging scripts, with dependencies installed.
After merging the script changes, the coordinator selects the immutable `main`
commit for the application build. Select the account explicitly. Load the Cloudflare token from your secret manager into `CLOUDFLARE_API_TOKEN`, or use the unlocked agent Vaultwarden CLI. Do not put tokens in command arguments.

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

Trusted synthetic send: read `API_KEY` from the protected state into a local environment variable and send bearer auth through a client that does not log headers. Without `MAILSTACK_STAGING_PRO` the Worker uses only the full key (all brands and templates, recipient override); send only synthetic simulator recipients. With `MAILSTACK_STAGING_PRO=<clean Pro checkout>` (and `MAILSTACK_STAGING_LICENSE` on the first deploy, a fixture license for the staging hostname) the build includes Pro keys, reading fixture JWKS/CRL from a second Worker at `mailstack-license-test.techskills.academy` (a Worker cannot fetch its own custom domain): clients `st-send` (acme/notice) and `st-hook` (Sellf hook, signed with `SELLF_STAGING_HMAC`), tokens `STAGING_SEND_TOKEN`/`STAGING_HOOK_TOKEN` in the state. Pro builds also add client `st-panel` (`panel`, all brands/templates, token `STAGING_PANEL_TOKEN`), the `PANEL_ASSERTION_KEYS` secret (keyring `[{kid, key}]`, kid `st-panel-1`, migrated from an earlier `PANEL_ASSERTION_KEY`), and the internal API host `mailstack-internal-test.techskills.academy` (Cloudflare Access application `Mailstack staging internal API`, service token `mailstack-staging-panel`, both created separately). Every deploy keeps `workers.dev` and preview URLs off. `MAILSTACK_STAGING_BRANCH` selects the branch that must contain the core commit (default `main`). Expect `503 delivery_disabled` in disabled mode. Public ALTCHA submissions also reach the disabled adapter after verification. The Sellf hook uses the same `API_KEY` plus `SELLF_STAGING_HMAC` (`legacyApiKey.signatureSecretEnv`); sign the exact JSON bytes as HMAC-SHA256 over `<unix-seconds>.<body>` and send `X-Sellf-Signature: t=<unix-seconds>,v1=<hex>`.

In SES mode the staging SNS topic fans out to both installations. The disabled-send response intentionally contains no message ID; administrators can inspect the staging D1 message rows. A provider event timeline remains empty until a provider event exists.

### Sellf source upgrade (Worker and Node)

Existing Sellf hook clients need `refund` alongside `payment`, `notice` and
`welcome` in their `templates` list; otherwise `refund.issued` returns `403` with
code `scope`. Worker staging generates this list automatically. Node staging
loads its existing external API configuration: update that client's list there
and recreate the API container. A `"*"` selection already includes `refund`.
The Node staging composition does not create or replace clients.

Idempotency keys changed from `sellf:` to `source:`. The new engine does not
look up old keys, so retrying an event sent by the former adapter within 24 hours
can send another email. Reconcile outstanding deliveries before upgrading either
installation; do not use pending old events as fresh staging fixtures.

## Node operations

The original SMTP deployment instructions below document the ST1 baseline. The current ST5 installation uses core `07d301d`, Pro `acf356c`, SES, and locally built `mailstack-staging-{api,panel}:st5-final` images. Prepare a new staging context as documented below for subsequent builds.

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

### Panel behind Tunnel + Access (target composition)

The panel on the staging host is reached through a Cloudflare Tunnel, not a published port. Pro's `compose.yml` has no `ports:` for any service; with `--profile production` it adds `cloudflared` (remotely managed tunnel, token read from `secrets/tunnel/token`, mounted read-only) and `backup` (daily encrypted copy, see [backup.md](backup.md)). The tunnel's public hostname points at `https://panel:8090` with `originServerName` set to the panel host and no-TLS-verify (the panel's own certificate is private); a Cloudflare Access application with an identity policy (owner e-mail, short session) guards that hostname before the passkey login. The panel container holds no content key.

API container environment (Node staging): `PANEL_AUDIENCE` (installation id; the API refuses `PANEL_ASSERTION_KEYS` without it), `PANEL_ASSERTION_KEYS` (the keyring shared with `secrets/panel/assertion`) and `TRANSIT_KEYS` (private set from `npm run keys`). `scripts/staging/node.mjs` only swaps the Sellf HMAC; it does not compose this environment, which is supplied by the Stackpilot installer or `api.env`.

```sh
# CLOUDFLARED_VERSION optionally overrides the pinned default (2026.10.0)
docker compose --profile production up -d
```

The temporary firewall allowance for the old panel port 3411 on `piotr` lived only in memory and in no file. Once the Tunnel is verified, confirm the port is closed (`ss -ltn` on the host, and a connection attempt from outside); this document does not record that as done.

### Worker egress behind the staging Tunnel (WP20B)

The Worker staging sends webhooks and resend callbacks only through the `egress` service of Pro's Compose (see Pro README, "Egress for the Worker"); there is no Cloudflare container. Target layout on `piotr`, in `/opt/stacks/mailstack-panel-worker` (the panel of the Worker staging):

- one remotely managed Tunnel `mailstack-staging-piotr`: `mailstack-panel-test.automagicznie.pl` → `https://panel:8090` (`originServerName` = that host, no TLS verify) and `mailstack-egress-test.automagicznie.pl` → `http://egress:8080`, catch-all 404; proxied CNAMEs to `<tunnel id>.cfargotunnel.com`;
- Access applications: egress host with a single Service Auth policy (service token `mailstack-staging-egress`, 401 instead of a login redirect); panel host with the owner identity policy and a short session;
- the egress host lives in `automagicznie.pl`, not in the Worker's zone, so the Worker reaches it as a public host and the receiver on `mailstack-test.techskills.academy` stays an allowed webhook target; `EGRESS_DENY_ZONES=automagicznie.pl`, `EGRESS_DENY_CIDRS=65.108.2.217/32,2a01:4f9:6a:5210::293/128` (the host's public IPv4 and IPv6, measured);
- `secrets/egress/keys` holds the `EGRESS_KEYS` value from the Worker staging state (`secrets.json`), `secrets/tunnel/token` the tunnel token; both 0600, owned by UID 1000.

Measured on `piotr` (WP20B, egress image alone with the production networks, no ports): from the egress network the host's services answer on the Docker gateway, `172.17.0.1` and the host LAN address `192.168.2.193`; the public IPv4 refuses connections, the network has no IPv6 route and no Tailscale address. The service refuses every one of these targets before connecting; a public target is reached. Treat the code rules as the only barrier between webhooks and the host.

Worker deploy with the egress (after the Tunnel exists):

```sh
MAILSTACK_STAGING_PRO=<clean Pro checkout> MAILSTACK_STAGING_BRANCH=target MAILSTACK_STAGING_DELIVERY=ses \
MAILSTACK_STAGING_EGRESS_URL=https://mailstack-egress-test.automagicznie.pl \
MAILSTACK_STAGING_EGRESS_ACCESS_ID=<client id> MAILSTACK_STAGING_EGRESS_ACCESS_SECRET=<client secret> \
MAILSTACK_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com MAILSTACK_ACCESS_AUD=<internal API app AUD> \
scripts/staging/worker.sh deploy
```

The deploy adds a webhook endpoint `st-receiver` (event `message.sent`, brand `acme`) pointing at the staging receiver run `m8`. Gate E5: `MAILSTACK_STAGING_EGRESS_URL=https://mailstack-test.techskills.academy MAILSTACK_STAGING_EGRESS_KEY=<STAGING_RECEIVER_KEY> MAILSTACK_STAGING_DENIED=mailpit.automagicznie.pl,65.108.2.217,2a01:4f9:6a:5210::293 npx vitest run test/staging-egress.test.ts`.

The account is on Workers Free and already uses all five Cron Triggers; the staging Worker keeps only `17 * * * *`. Without the minute cron, background jobs run only when a request that records a durable event starts the job runner (`kickJobs`); retries after a failure wait for the next such request. Whether a new delivery completes in that same pass has not been measured on staging.

### Simulator-only SES delivery

The Worker staging script defaults to disabled delivery. To enable the existing
SES staging identity and event destination, run:

```sh
CLOUDFLARE_ACCOUNT_ID=92e7018cfc666807c755836278d19eaf \
MAILSTACK_STAGING_DELIVERY=ses scripts/staging/worker.sh deploy
```

The script reads the dedicated `Mailstack staging SES` Vaultwarden item from the
agent profile. It uploads the credentials as `secret_text` bindings, without
saving them to staging state or build files. Optional `SES_ACCESS_KEY_ID` and
`SES_SECRET_ACCESS_KEY` environment inputs support automation; provide only the
dedicated staging credentials. Never pass credentials as CLI arguments.

This mode sets `SES_CONFIGURATION_SET=mailstack-staging`, exact SNS topic/account
allowlists, signature v2 only, `masked` logging with `requireLog`, and disables
brand auto-replies. The send client can override recipients; the staging provider
adapter checks every send against the exact success, bounce, complaint and
suppressionlist simulator addresses and the dedicated staging From address.
All configured brand recipients default to the success simulator. Production
fingerprint checks still surround each Cloudflare mutation. Repeating the same
command rebuilds the pinned core commit and reuses the same staging resources.

Subscribe only the staging SNS topic to the staging `/v1/events/ses` endpoint,
with standard SNS envelopes. Read the confirmed subscription ARN separately.
Simulator messages incur normal SES sending charges; use three small messages
with unique idempotency keys and inspect recorded events before retrying.

The original ST1 Node/Pro images used SMTP and predated the AWS panel loop test. Running that
test needs a Pro build containing `src/aws/api.ts` and `src/panel/aws-views.ts`, a
compatible core with SES status support, and explicit Pro `aws` options and an
SES-enabled test brand. A Worker message is not present in Node's separate SQLite
store; forwarding its SNS event to Node does not prove Node delivery or webhook
correlation. Configure and test that separate path before asserting its result.

### Persistent SES budget in staging compositions

The ST5 compositions wrap SES before calling AWS. Production `src/`, its normal
Node build and IAM sender are unchanged. The reusable staging adapter defaults to
100 recipients/rolling 24 hours and 20/rolling hour. The deployed installations
split that allowance: **50/day and 10/hour each**, so their combined allowance is
100/day and 20/hour. Configuration may lower these allocations; requests cannot
change them. Do not increase one installation without reducing the other.

Worker deployment inputs are `MAILSTACK_STAGING_SES_DAY` and
`MAILSTACK_STAGING_SES_HOUR`; Node inputs are `STAGING_SES_DAY` and
`STAGING_SES_HOUR` in the staging Compose environment. Recreate the Node container
after changing its environment; a Docker restart retains the old environment.
The Worker ledger is in its dedicated staging D1. Node uses
`/data/staging-ses-budget.db` on its persistent staging data volume. Preserve these
stores across deploys and restarts. Resetting a ledger resets its budget.

An atomic conditional INSERT reserves recipient units against both rolling
windows. An admitted call consumes its reservation even after provider refusal or
an uncertain outcome; this is deliberately conservative. Local rejection does not
call SES, records a `st5_rejections` event and returns `429 staging_ses_limit`.
Storage errors fail closed with `503 staging_ses_store_unavailable` and a safe
console event if the rejection audit cannot be written. The shared delivery
pipeline records explicit failure and permits the same idempotency key to retry
after the window. Multiple recipients count separately. Simulator recipient and
staging sender checks apply to Node as well as Worker, including Pro resend.

Prepare the Node staging context without editing core or Pro product sources:

```sh
node scripts/staging/node-context.mjs /path/to/core /path/to/pro /new/context
```

Deploy that context using the existing staging Stackpilot installation and the
existing staging keys/license. Its build script instruments only the staging
bundle, wrapping public and internal delivery requests. The installer currently
replaces extension options: preserve and restore API `options.aws` after redeploy;
never add it to the strict panel license options. Verify health and the effective
budget inputs before enabling a test. Keep production deployment fingerprint
reads around every Cloudflare mutation.

AWS Budgets alerts are delayed billing monitors, not real-time send limits.
A service-filtered SES/SNS budget includes production costs and must have **no
blocking action**. Simulator sends are billed but do not consume the daily SES
quota or reputation bounce/complaint rates; they still share the maximum send
rate. Keep test pacing low and record quota headroom before testing.

## Sellf webhook event selection

In Sellf's webhook endpoint settings, select **only events supported by Mailstack**
according to the [README event table](../README.md#sellf-event-contract). For the
purchase/refund flow, select only `purchase.completed` and `refund.issued`; enable
other supported events only when needed. Leave known unsupported events unchecked:
Mailstack returns `422 unsupported_event`, and Sellf treats 422 as a retryable error
(observed retries, up to five attempts). This recommendation does not change the
hook's 422 response.

## SES i SNS (ST2)

Region: `eu-west-1`, konto `207570392857`. Nadawca:
`Mailstack staging <no-reply@mailstack-test.techskills.academy>`.
Osobna tożsamość domenowa Easy DKIM: `mailstack-test.techskills.academy`.
Configuration set: `mailstack-staging`; temat SNS:
`arn:aws:sns:eu-west-1:207570392857:mailstack-staging-events`.

**Stan zmierzony 29.10.2026:** konto ma `ProductionAccessEnabled: true`.
Sandbox SES dotyczy konta w regionie, a nie tożsamości ani configuration set.
ST2 nie zmienia tego ustawienia. Ograniczenie stagingu zapewnia dedykowany
użytkownik IAM z polityką `scripts/staging/ses-policy.json`, dopuszczającą tylko
cztery dokładne adresy symulatora. Bez tej polityki i dedykowanego klucza
wysyłka Workera ma pozostać wyłączona. Nie używaj kluczy produkcji ani `default`
do wysyłania z aplikacji.

### Zarządzanie zasobami

Wymagane: Bash, Python 3, AWS CLI, odblokowane konto agenta Vaultwarden.
Cloudflare token jest pobierany w pamięci z `CF Deploy - General API token`.
Nie przekazuj sekretów jako argumentów CLI ani nie włączaj śledzenia powłoki.

```bash
source ~/.zshenv
scripts/staging/ses.sh status
scripts/staging/ses.sh create
# Usuwa tylko staging SES/SNS oraz jego dokładne CNAME DKIM:
scripts/staging/ses.sh destroy
```

Skrypt używa wyłącznie profilu AWS `default`, sprawdza ARN użytkownika `pavvel-cli`
i stałe konto/region/nazwy zasobów. Nie zarządza IAM ani kluczami.
`create` można powtarzać; oczekuje maksymalnie około dwóch minut na Easy DKIM.
Dowody i pełne listy DNS przed/po zapisuje poza repo w
`~/.local/state/mailstack-staging-ses/<UTC>/` (katalog 0700, pliki 0600).
`MAILSTACK_SES_STATE` pozwala wskazać inny katalog poza repo.
Różnica DNS może obejmować wyłącznie oczekiwane rekordy DKIM; wszystkie inne
rekordy oraz listy produkcyjnych SES/SNS i wdrożenia Workera `mailstack`
muszą być identyczne. Niedostępna lista IAM jest oznaczana `UNAVAILABLE`.
`destroy` nie usuwa użytkownika IAM ani wpisu Vaultwarden; owner powinien osobno
wycofać klucz i usunąć dedykowanego użytkownika po zakończeniu stagingu.

### IAM: czynność ownera

`pavvel-cli` otrzymał AccessDenied dla `iam:CreateUser` i `iam:ListUsers`.
Nie rozszerzaj jego uprawnień. Osoba z istniejącymi uprawnieniami administracji
IAM powinna:

1. Sprawdzić, czy `mailstack-staging-ses` już istnieje; jeśli tak, sprawdzić jego
   polityki, grupy i klucze zamiast tworzyć następny klucz.
2. Utworzyć użytkownika bez dostępu do konsoli, bez grup i bez innych polityk.
3. Dodać inline policy `mailstack-staging-send` z pliku
   `scripts/staging/ses-policy.json`:

   ```bash
   aws iam create-user --user-name mailstack-staging-ses
   aws iam put-user-policy --user-name mailstack-staging-ses \
     --policy-name mailstack-staging-send \
     --policy-document file://scripts/staging/ses-policy.json
   ```

4. Utworzyć **jeden** klucz w konsoli IAM i zapisać bezpośrednio w Vaultwarden,
   organizacja TechSkillsAcademy, kolekcja Infra, wpis `Mailstack staging SES`:
   username = Access Key ID, password = Secret Access Key; region i ARN w notatce.
   Nie używać polecenia `create-access-key` wypisującego sekret do terminala.
   Nie zapisywać klucza w plikach, repo, logach ani raportach.
5. Zweryfikować zakres polityki i brak innych uprawnień; przekazać ST1 możliwość
   zasilenia wyłącznie sekretów stagingu. Uzupełnić porównanie użytkowników IAM
   wykonane przez uprawnioną osobę.

Polityka dopuszcza tylko stagingowe ARN-y tożsamości i configuration set.
Wywołanie aplikacji musi podawać `SES_CONFIGURATION_SET=mailstack-staging`;
lista ARN-ów sama nie wymusza obecności opcjonalnego parametru configuration set.
Skrypt nie zmienia kontowego sandboxa ani planu cenowego SES.

### Po wdrożeniu ST1: podłączenie zdarzeń

Worker: `https://mailstack-test.techskills.academy`. Endpoint odczytany z
`src/index.ts` i README: `/v1/events/ses`. Konfiguracja Workera musi zawierać:

```json
{"events":{"ses":{
  "topicArns":["arn:aws:sns:eu-west-1:207570392857:mailstack-staging-events"],
  "accountIds":["207570392857"]
}}}
```

Ustaw `SES_REGION=eu-west-1`, `SES_CONFIGURATION_SET=mailstack-staging`,
dedykowane `SES_ACCESS_KEY_ID`/`SES_SECRET_ACCESS_KEY` oraz stagingowe
`CONTENT_PUBLIC_KEYS` i `INDEX_KEYS`. Włącz zapis wiadomości: poziom `masked`
i `requireLog: true`. Dla `none` aplikacja nie dodaje tagów korelacyjnych ani
configuration set. Ustaw brand.to na adres symulatora i wyłącz auto-reply.

Po skonfigurowaniu i wdrożeniu Workera uruchom ponownie `create`, albo wykonaj:

```bash
aws --profile default --region eu-west-1 sns subscribe \
  --topic-arn arn:aws:sns:eu-west-1:207570392857:mailstack-staging-events \
  --protocol https \
  --notification-endpoint https://mailstack-test.techskills.academy/v1/events/ses \
  --attributes '{"RawMessageDelivery":"false"}'
```

Worker potwierdza subskrypcję po walidacji podpisu SNS v2. `status` zapisuje
listę subskrypcji: wymagany rzeczywisty ARN zamiast `PendingConfirmation`.
Jeśli potwierdzenie nie doszło, po naprawie konfiguracji ponów `sns subscribe`
z tymi samymi parametrami; skrypt nie powiela istniejącej subskrypcji.

### Symulator i odczyt wyników

| Odbiorca | Oczekiwane zdarzenie |
| --- | --- |
| `success@simulator.amazonses.com` | Delivery |
| `bounce@simulator.amazonses.com` | Bounce |
| `complaint@simulator.amazonses.com` | Complaint |
| `suppressionlist@simulator.amazonses.com` | Bounce (symulacja suppression list) |

Wysyłaj pojedyncze syntetyczne wiadomości przez `/v1/send` z dedykowanym
klientem stagingu. Zachowaj zwrócone `id`; w panelu/oś czasu i API logów
sprawdź tę samą wiadomość oraz jej zdarzenia. `Send` oznacza przyjęcie przez SES,
`Delivery` doręczenie symulatorowi, `Bounce` odrzucenie, a `Complaint` ustawia
flagę reklamacji. Temat emituje SEND, DELIVERY, BOUNCE, COMPLAINT i REJECT;
nie włączono płatnych dodatków ani śledzenia open/click.
Żądanie wysłane bez logu nie da pełnego testu korelacji. Potwierdzenie subskrypcji
nie jest dowodem poprawnej obsługi Delivery/Bounce/Complaint: te trzy zdarzenia
trzeba sprawdzić po ST1 i IAM. ST2 nie wysyłał wiadomości.

Nie zweryfikowano Mailpita jako odbiorcy poczty tej domeny; nie jest odbiorcą SES.
Nie kieruj żadnych prób na skrzynki ludzi.

### Koszty

Tożsamość, Easy DKIM, configuration set, standardowy temat i DNS nie mają opłaty
stałej. Symulator SES jest **płatny jak zwykła wysyłka**; sandbox nie zwalnia z opłat.
Dla planu à la carte stawka wynosi 0,10 USD/1000 wiadomości plus dane. Cztery małe
wiadomości to około 0,0004 USD plus dane i SNS. Nie uruchamiaj testów obciążeniowych.
SNS ma darmowe limity konta; ich dostępności dla stagingu nie potwierdzono.
Nie aktywuj SES Pro, VDM, dedicated IP ani innych dodatków.

Odczyt `budgets describe-budgets` zwrócił exit 0, ale pusty wynik (również po
`--no-paginate`); nie potwierdzono istniejącego budżetu. Propozycja dla ownera:
sprawdzić AWS Budgets i dodać powiadomienie kosztowe dla SES/SNS, np. 1 USD/mies.,
bez automatycznych płatnych akcji. ST2 nie tworzy budżetu ani alarmu CloudWatch.

Źródła: [sandbox per region](https://docs.aws.amazon.com/ses/latest/dg/regions.html),
[symulator i rozliczanie](https://docs.aws.amazon.com/ses/latest/dg/send-an-email-from-console.html),
[cennik SES](https://aws.amazon.com/ses/pricing/),
[cennik SNS](https://aws.amazon.com/sns/pricing/).

## Manual test entry conditions (single checklist)

The coordinator must complete this list before assigning a browser slot. A local
record or an old ST report is not evidence of current deployment readiness.

Script preparation and local checks are separate from operational readiness.
The preparation task ends with committed code and documentation, without a
staging deployment or new RC briefs. After merge, the separate coordinator task
deploys the composition, measures the receiver and HMAC swap/restore on both
installations, records production fingerprints, freezes versions, and writes
the new RC briefs. Until those measurements exist, the affected manual tests
remain blocked; passing local tests does not establish staging readiness.

| Condition | Required evidence and recovery |
| --- | --- |
| Version freeze | One immutable core SHA and Pro SHA, API/panel image IDs and bundle hashes, configuration digests, health from both staging URLs above, and matching LOCAL/W manifests. Freeze these for the whole cycle; repeat affected tests if they change. |
| TEST-WORKER | Run `scripts/test-worker.sh status`. This is a local, read-only operation, without Vaultwarden or Cloudflare access. Default record: `/private/tmp/mailstack-test-worker/status.json` (0600). `MAILSTACK_TEST_WORKER_STATUS` selects a delivered copy. Missing/incomplete record exits 3 with the exact path; existing record says `RECORDED_NOT_LIVE_VERIFIED`. Coordinator supplies current health/SHA/config/delivery evidence separately. The disposable `mailstack-test` + `mailstack-preview` environment is distinct from permanent SES staging. Testers do not deploy it to unblock themselves. |
| Receiver | Deploy the staging composition containing `receiver.ts`, then verify the POST/GET/DELETE operations below with a unique run ID. Preserve raw evidence locally before cleanup/retention. A historical 404 endpoint is insufficient. |
| Hook HMAC | Node: dedicated Pro client `staging-hook`, acme, payment/refund/notice/welcome; Worker: full `API_KEY`. Bearer plus configured HMAC. Ensure original-secret probes succeed before swapping. Complete swap/restore with the commands below in an exclusive coordinator-assigned slot. |
| Delivery budget | Current independent Node SQLite and Worker D1 ledgers, 50/day and 10/hour each, dedicated simulator-only IAM evidence, SES From/configuration set and confirmed SNS subscriptions. Reserve every possible provider call, including refusal/unknown, before sending. Never reset a ledger or transfer a rejected send to the other installation. |
| Critical journey | Node Pro, step-up and permitted resend strategy must be ready before the purchase. Node messages live in SQLite, Worker messages in D1. SNS fan-out does not merge them. Use only synthetic simulator recipients; SES offers no readable MIME inbox. Compare MIME separately on LOCAL with the same versions. |
| Recovery | Keep original configuration/keys and HMAC recovery files outside repositories. On failure stop dependent tests, restore HMAC, verify both signatures and health, then remove only the run's receiver rows and owned resources. Leave staging, shared inbox, audit and budgets running/intact. |

After a coordinator deploy and an IDENTICAL production fingerprint measurement,
write new RC-6/RC-7 briefs with fresh seeds and the normal reporting/cleanup
contract. RC-6 repeats RC-5 E1-E7, including real Sellf → Node → SES/SNS → Pro →
resend → receiver and separately Sellf → Worker → SES/SNS/D1, with a total ceiling
of 40 sends and the actual shared allocation reserved first. Do not run these
journeys as part of preparing scripts.

RC-7 must explicitly carry forward RC-1's missing W controls S017, S018, S019,
S022, S024, S058, S063-S071, and S059/S152 exact
HMAC boundaries, S162/INTEGRATOR-001 activation, S178 provider/store faults, S029
audit-read failure and S128 native zoom. From RC-4 carry D9.5 live D1/config
verification, real limiter/SES evidence, D6.4 natural guard expiry, D7.5 HTTPS
response cap, S165/S178 runtime send_failed emission, and S145-S158 complete
historical envelopes/rejects (INTEGRATOR-004/008), plus the common freeze and
active-time accounting gaps. Keep the reports' qualified results distinct from
PASS. Each brief ends `TASK-DONE RC-n`, with findings numbered `RC-n-001` in
`| FINDING | RC-n-001 | ... |` rows. Do not rewrite historical briefs or reports.

### Persistent staging receiver

Deployment generates and retains `STAGING_RECEIVER_TOKEN` and
`STAGING_RECEIVER_KEY` in protected Worker `secrets.json`, and binds both as
secret text. Do not print them, put them in argv/history, or copy them to reports.
Endpoint: `https://mailstack-test.techskills.academy/_staging/receiver/<token>/<run>`.
Use a fresh 1-64 character alphanumeric/underscore/hyphen run ID per tester.

POST captures the exact body as base64, headers as JSON, receipt time (epoch ms),
run, optional JSON `id`, mode and ledger decision. It responds 204 by default;
`?mode=500` responds 500, `?mode=timeout` waits 15 seconds then responds 204
(the caller must have a shorter timeout). Select modes only for your own endpoint.
Each physical attempt is stored; the first run+event.id has decision `accepted`,
repeats `duplicate`. This ledger records receipt, not business processing or HMAC
validity. Independently verify the outgoing webhook signature over decoded bytes.
Malformed/non-JSON bodies are still captured with an empty eventId.

GET the same URL with `Authorization: Bearer <STAGING_RECEIVER_KEY>` to read only
that run, ordered by receipt ID. Each response is an object
`{ "requests": [...], "nextCursor": "10" }` containing at most 10 complete records.
Start without query parameters (equivalent to `?after=0`). Save each page, then
GET `?after=<nextCursor>` with the same key and run until `nextCursor` is `null`.
The cursor is the last returned ID, not an offset; gaps and other runs do not
change the continuation. Invalid cursors return 400. The page size is fixed:
SQL loads at most 11 records (one lookahead), including at maximum input size.
Decode each record's `bodyBase64` to recover its original bytes; `headers` remains
a JSON string and all ledger fields accompany every record. Export one page at a
time rather than collecting all pages in Worker memory. New arrivals with higher
IDs can appear on later pages; this is not a frozen snapshot. Export after the
sender stops and before retention, without deleting the run during retrieval.
DELETE with the same key removes only that run.
Do not send the read key to the POST receiver or include live/customer credentials
in captured headers. Reads use `Cache-Control: no-store`. No CORS is enabled.

The separate `staging_receiver` table exists only in staging D1; no product
migration is added. Bodies are limited to 64 KiB including streaming input,
headers to 16 KiB and all retained attempts to 1000. A full store returns 507,
storage failure 503, oversized input 413; no capture success is claimed then.
Rows expire after 24 hours, removed on receiver access and hourly staging cron.
The maximum stored request data is roughly 100 MiB including base64 overhead.
Export evidence before expiry; cleanup never touches SES budgets or product rows.

### Temporary hook HMAC operations

These operations change one staging secret, never product code. They do not
provision the Node HMAC binding. Worker binds the HMAC to its full key. Before first use on Node, the coordinator must configure
only dedicated `staging-hook` (a Pro client; Node staging runs licensed Pro) with `signatureSecretEnv` (or its Sellf alias)
pointing to an existing plain environment value. On Node the corresponding
`.env` entry must be a single unquoted `NAME=value` line, and Compose must pass
it into API. The operation rejects an absent binding or a mismatch with the live
container. Do not change scopes, policies or recipients as part of a swap.

Supply the temporary Sellf endpoint secret on stdin from a protected file, never
as an argument. Worker uses its existing protected state and `API_KEY`:

```sh
scripts/staging/worker.sh hmac-swap < /secure/temporary-sellf-secret
# Always, including after a failed swap:
scripts/staging/worker.sh hmac-restore
```

Node commands run on **piotr293**, with the scripts installed by the coordinator,
against only `/opt/stacks/mailstack-staging`. Load
`MAILSTACK_STAGING_HOOK_TOKEN` and `CLOUDFLARE_API_TOKEN` into the process environment
from the approved secret store. The latter needs only production deployment
metadata read access. Default HMAC environment name is `SELLF_STAGING_HMAC`;
`MAILSTACK_STAGING_HMAC_ENV` may select the already configured hook binding.

```sh
node scripts/staging/node.mjs hmac-swap < /secure/temporary-sellf-secret
node scripts/staging/node.mjs hmac-restore
```

Node atomically replaces just that `.env` line and runs
`docker compose up -d --no-deps --force-recreate api` in the fixed staging stack;
panel/gateway are not recreated. An ordinary restart does not reload environment.
Other `.env` lines stay byte-identical. Temporary Node values must contain 16-256
letters, digits, underscores or hyphens. Restore works with a stopped API
container, no API container, or both old and replacement API containers after an interrupted recreation. Every existing API
container must match the staging working directory and API service. Swap requires
exactly one container; restore recreates API from the saved secret and requires
exactly one matching container afterward before checking both signatures.

Before mutation each operation creates `hmac-backup.json` exclusively (0600),
containing original/temporary values, installation identity and production
fingerprint. Worker recovery is in its protected state directory; Node recovery
is `/opt/stacks/mailstack-staging/hmac-recovery/`. A lock excludes concurrent
operators and a second swap cannot overwrite recovery material. Both adapters
read the production deployment fingerprint before/after applying; mismatch stops
work and retains the backup. Worker also uses its per-mutation fingerprint guard.
No production D1, secret or application traffic is read.

Swap first probes original→200 ignored and temporary→401, then reverses these
expectations after applying. Restore requires original→200 ignored and
temporary→401, then removes the backup only after success. Probes use a signed
unknown event and send no mail. Propagation checks are bounded to 12 attempts.
Worker updates only the staging HMAC secret binding and its local secret copy;
it does not redeploy a product build. Node verifies the recreated container value.

If interrupted, run restore with the same identity/directory; failed verification
retains recovery material. After an ungraceful process death a lock can remain:
coordinator must verify that no operator process is alive before removing only
`hmac.lock`. Do not remove the backup. A changed production fingerprint requires
coordinator reconciliation before another operation. Restore both installations
separately, remove temporary secret files, and confirm health and configuration
before releasing the slot. Never claim IDENTICAL without the recorded measurement.

Both adapters verify the active signature returns `200 ignored` and the previous
signature returns `401` in the same successful attempt. Verification retries
transport failures, timeouts, non-JSON responses and unexpected results for up to
12 attempts, with a one-second pause between attempts and a ten-second timeout
per request. The entire signature pair is checked again after any failed attempt.
If verification is exhausted, the command fails and retains recovery material;
run `hmac-restore` after recovering endpoint availability. A restore removes the
backup only after successful verification. These retries never reapply a secret
or send mail: the probe uses an ignored event.
