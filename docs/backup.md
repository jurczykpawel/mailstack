# Offsite backups and restore

Mailstack keeps a daily copy of the API database outside the hosting provider
(recovery point: 24 hours); in profile (a) the same run also copies the panel
Worker's D1 database. The copy is encrypted with [age](https://age-encryption.org)
to the owner's public key and uploaded to a Backblaze B2 bucket through the S3 API.
The server that makes the copy holds only the public key; it can neither decrypt
nor read back earlier copies.

| Runtime | Source | Object in the bucket |
|---|---|---|
| Cloudflare Worker | D1 export through the Cloudflare API (SQL dump, no Wrangler needed); each listed database separately | `mailstack/<database id>-<UTC time>.sql.age` |
| Node | newest daily SQLite snapshot (`/data/backups/mailstack-YYYYMMDD.db`) | `mailstack/mailstack-YYYYMMDD.db.age` |

The copy contains the same data as the database: plain metadata (brand, template,
status, times, address hints, event summaries, audit) and sealed values. A useful
restore also needs the keys kept offline by the owner: all content private keys,
all index keys (search and resend checks), assertion and transit keys, the
configuration with its `BUILD_CONFIG_SHA` and the migration manifest. Without the
old index keys the restored database cannot be searched.

## One-time setup

1. **Owner key (offline).** On the owner's computer: `age-keygen -o mailstack-backup.key`.
   Store the file with the other offline keys. The printed `age1...` public key is
   `BACKUP_AGE_RECIPIENT`. The private key never goes to a server.
2. **Bucket.** Create a private B2 bucket and a lifecycle rule that keeps copies
   for 30 days:
   `{"fileNamePrefix": "mailstack/", "daysFromUploadingToHiding": 30, "daysFromHidingToDeleting": 1}`.
3. **Upload key.** Create a B2 application key limited to this bucket with only the
   `writeFiles` capability. Without `readFiles` and `deleteFiles` the backup host
   cannot read or remove existing copies; retention is the bucket's job.
4. **Cloudflare token (Worker only).** A separate account API token whose only
   permission is D1 on this account, plus `CLOUDFLARE_ACCOUNT_ID` and the database
   id (`MAILSTACK_D1_ID`; in profile (a) also the panel's `PANEL_D1_ID`). The copy calls `POST /accounts/<id>/d1/database/<id>/export`,
   polls until the dump is ready and downloads it from the signed URL. Keep this
   token only in `backup.env`; never reuse the deploy token.

| Variable | Meaning |
|---|---|
| `BACKUP_AGE_RECIPIENT` | owner public key, `age1...` |
| `B2_ENDPOINT` | S3 endpoint of the bucket region, e.g. `https://s3.eu-central-003.backblazeb2.com` |
| `B2_BUCKET` | bucket name |
| `B2_KEY_ID`, `B2_APP_KEY` | application key from step 3 |
| `BACKUP_SOURCE` | `d1` (Worker, profiles a and b) or `sqlite` (Node, profile c); required, never guessed |
| `BACKUP_D1_ID` | with `BACKUP_SOURCE=d1`: the API database id; in profile (a) the API and the panel database ids, comma-separated (`<api id>,<panel id>`) |
| `BACKUP_SQLITE_DIR` | snapshot directory, with `BACKUP_SOURCE=sqlite` (default `/data/backups`) |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Worker only, step 4 |

## Daily copy

```bash
node scripts/backup/export.mjs                       # source from BACKUP_SOURCE (Compose)
node scripts/backup/export.mjs --d1 <database id>    # Worker (D1), manual run
node scripts/backup/export.mjs --sqlite-dir /data/backups   # Node (newest snapshot)
```

The command prints each uploaded object key and exits with a non-zero code on any
failure. With several D1 databases each one is exported and uploaded on its own: a
failing one does not hold back the others, and the run still fails, naming it and
the copies that were uploaded (missing recipient, missing or unknown source, failed export, no snapshot,
rejected upload). Nothing is uploaded unencrypted. In production it runs once a day
as the `backup` service of the panel's Compose stack, which reads `BACKUP_SOURCE`
from `backup.env`; profile (b) starts it with the panel, profile (a) with only
`cloudflared` and `egress` on the server, profile (c) reads the API data volume
mounted read-only.

Notes:

- A running D1 export blocks other requests to that database for its duration;
  schedule it outside peak hours.
- The file is processed in memory; the backup host needs about twice the database
  size in free RAM.
- Provider copies are separate: Cloudflare keeps D1 Time Travel history for up to
  30 days (Paid) or 7 days (Free), Node keeps seven local snapshots on the same volume.

## Erasure register

A restored copy must not bring back messages erased after it was taken. Every API
erase job therefore first writes its scope to `<TOMBSTONE_PREFIX><job id>.age` in
the same bucket: `{job, tombstones: [{kid, index, at, brands, templates}]}`,
encrypted with age to `BACKUP_AGE_RECIPIENT`. It holds blind indexes, brand and
template selections and the time bound, never an address. The object is written
before the job hides or deletes anything; while B2 refuses, the job keeps its data
and retries after 1 minute, 10 minutes, 1 hour and 6 hours. After five failed
attempts the job ends `dead` with nothing erased, and the erasure must be repeated
from the panel. The job runs in the API (Worker cron or Node job clock), so neither
the panel nor a browser has to stay connected.

Setup on the API (Worker secrets with `npx wrangler secret put`, Node `api.env`):

| Variable | Meaning |
|---|---|
| `B2_ENDPOINT`, `B2_BUCKET` | the backup bucket |
| `B2_KEY_ID`, `B2_APP_KEY` | a separate application key: this bucket, name prefix `tombstones/`, only `writeFiles` |
| `BACKUP_AGE_RECIPIENT` | the owner public key |
| `TOMBSTONE_PREFIX` | optional, default `tombstones/`; staging uses its own, e.g. `staging-tombstones/` |

Without any of these variables the register is off and erasures run without it
(development only). A partial set stops the Node API at start and holds erase
jobs on the Worker. The API key cannot read or delete register objects.

Keep register objects longer than any copy that predates them: at least the copy
retention and the provider history (30 days each) plus a margin, for example
`{"fileNamePrefix": "tombstones/", "daysFromUploadingToHiding": 45, "daysFromHidingToDeleting": 1}`.

## Restore

A restore never writes into a database in use. It accepts only a **new SQLite file**
(the path must not exist) or an **empty D1 database**; anything else is refused
before any data is written. A damaged file or a wrong key is refused before the
target is touched.

1. Download the chosen object from the bucket (B2 web UI, `b2` CLI or rclone) on the
   owner's computer, where the private key lives.
2. Restore:

   ```bash
   # new D1 database next to the one in use
   npx wrangler d1 create mailstack-restore-20261103
   node scripts/backup/restore.mjs mailstack-20261103T030000Z.sql.age \
     --identity mailstack-backup.key --d1 mailstack-restore-20261103

   # new SQLite file (Node); a D1 export can also be restored this way
   node scripts/backup/restore.mjs mailstack-20261103.db.age \
     --identity mailstack-backup.key --sqlite /new-volume/mailstack.db
   ```

   A Node snapshot (`.db.age`) restores only to `--sqlite`. A panel D1 copy
   (profile a) restores the same way into a new D1 database; the Pro README
   describes the panel steps after it.
3. Continue with the recovery procedure on the new database before switching:
   re-apply erasures from the erasure register (Mailstack Pro panel CLI
   `tombstones replay --identity <owner key> --since <copy time>`, with a temporary
   B2 key that may list and read the register prefix; see the Pro README; in
   profile (a) the CLI runs on the owner's computer, reads the panel's erase jobs
   from its D1 and reaches the restored API through the emergency internal route,
   `docs/internal-api.md`, so there the switch in step 4 is deployed with that route
   and the replay runs right after it), quarantine events and deliveries
   from before the restore point, reconcile `sending`/`unknown` messages, then check
   the list, content decryption in the browser, address search and the audit chain.
4. Switch: Worker — set `MAILSTACK_D1_ID` to the new database, `npm run setup`,
   deploy; Node — stop the API, point the data volume at the new file, start.
   Messages sent between the restore point and the switch stay in the old database
   and are exported to the owner's archive; they are not merged automatically.
