# Offsite backups and restore

Mailstack keeps a daily copy of the API database outside the hosting provider
(recovery point: 24 hours). The copy is encrypted with [age](https://age-encryption.org)
to the owner's public key and uploaded to a Backblaze B2 bucket through the S3 API.
The server that makes the copy holds only the public key; it can neither decrypt
nor read back earlier copies.

| Runtime | Source | Object in the bucket |
|---|---|---|
| Cloudflare Worker | D1 export through the Cloudflare API (SQL dump, no Wrangler needed) | `mailstack/<database id>-<UTC time>.sql.age` |
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
   id (`MAILSTACK_D1_ID`). The copy calls `POST /accounts/<id>/d1/database/<id>/export`,
   polls until the dump is ready and downloads it from the signed URL. Keep this
   token only in `backup.env`; never reuse the deploy token.

| Variable | Meaning |
|---|---|
| `BACKUP_AGE_RECIPIENT` | owner public key, `age1...` |
| `B2_ENDPOINT` | S3 endpoint of the bucket region, e.g. `https://s3.eu-central-003.backblazeb2.com` |
| `B2_BUCKET` | bucket name |
| `B2_KEY_ID`, `B2_APP_KEY` | application key from step 3 |
| `BACKUP_SOURCE` | `d1` (Worker, profile b) or `sqlite` (Node, profile c); required, never guessed |
| `BACKUP_D1_ID` | D1 database id, with `BACKUP_SOURCE=d1` |
| `BACKUP_SQLITE_DIR` | snapshot directory, with `BACKUP_SOURCE=sqlite` (default `/data/backups`) |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Worker only, step 4 |

## Daily copy

```bash
node scripts/backup/export.mjs                       # source from BACKUP_SOURCE (Compose)
node scripts/backup/export.mjs --d1 <database id>    # Worker (D1), manual run
node scripts/backup/export.mjs --sqlite-dir /data/backups   # Node (newest snapshot)
```

The command prints the uploaded object key and exits with a non-zero code on any
failure (missing recipient, missing or unknown source, failed export, no snapshot,
rejected upload). Nothing is uploaded unencrypted. In production it runs once a day
as the `backup` service of the panel's Compose stack, which reads `BACKUP_SOURCE`
from `backup.env`; profile (b) starts it with the panel, profile (c) reads the
API data volume mounted read-only.

Notes:

- A running D1 export blocks other requests to that database for its duration;
  schedule it outside peak hours.
- The file is processed in memory; the backup host needs about twice the database
  size in free RAM.
- Provider copies are separate: Cloudflare keeps D1 Time Travel history for up to
  30 days (Paid), Node keeps seven local snapshots on the same volume.

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

   A Node snapshot (`.db.age`) restores only to `--sqlite`.
3. Continue with the recovery procedure on the new database before switching:
   re-apply erasures from the tombstone register, quarantine events and deliveries
   from before the restore point, reconcile `sending`/`unknown` messages, then check
   the list, content decryption in the browser, address search and the audit chain.
4. Switch: Worker — set `MAILSTACK_D1_ID` to the new database, `npm run setup`,
   deploy; Node — stop the API, point the data volume at the new file, start.
   Messages sent between the restore point and the switch stay in the old database
   and are exported to the owner's archive; they are not merged automatically.
