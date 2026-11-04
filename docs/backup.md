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

A restored copy must not bring back messages erased after it was taken. Before hiding
or deleting data, the API records each erasure in B2. `genesis` identifies the
register, `head` records its sequence and hash, and `1.age`, `2.age`, ... contain
age-encrypted `{registry, seq, prev, job, tombstones}`. `prev` is the SHA-256 of the
previous ciphertext (for entry 1, of `genesis`). The API keeps the exact ciphertext
and allocated sequence in its database, atomically with the erase job cursor.
Independent API instances share that database; a unique sequence allows only one
allocation, and the next waits for confirmation of the previous entry and head.
The private age key stays on the owner's computer.

Setup on the API (Worker secrets with `npx wrangler secret put`, Node `api.env`):

| Variable | Meaning |
|---|---|
| `B2_ENDPOINT`, `B2_BUCKET` | the backup bucket |
| `B2_KEY_ID`, `B2_APP_KEY` | separate key restricted to this bucket and register prefix, with `writeFiles` and `readFiles`; no `deleteFiles` |
| `BACKUP_AGE_RECIPIENT` | owner public age key |
| `TOMBSTONE_REGISTRY_ID` | stable random installation id (16–128 letters, digits, `_` or `-`); keep it with the configuration and all backups |
| `TOMBSTONE_PREFIX` | optional, default `tombstones/`; use a distinct prefix for staging |

On the owner's computer, choose an empty prefix and set the variables above.
Generate an id once, for example `openssl rand -hex 16`, retain it, then explicitly
initialize the register using an installation key with `listFiles`, `readFiles`
and `writeFiles` on that prefix:

```bash
node scripts/backup/init-register.mjs
```

This refuses a prefix holding anything other than this register's own `genesis`
and `head` at sequence 0; with only those (a response lost after the write), a rerun
with the same `TOMBSTONE_REGISTRY_ID` completes them without rewriting. Run it with a
single installer while the API is stopped. Neither a 404 nor an erasure automatically initializes a register. Existing
unnumbered registers are refused: retain them and complete their restore procedure
with the matching previous release before moving to a fresh register.

Missing or partial configuration makes erasure unavailable (`subjects.erase` in
capabilities: `erasure_registry_unavailable`, requests return 503 before creating a
job). Sending remains available. Local development may explicitly set
`MAILSTACK_DEV_ERASE_WITHOUT_REGISTRY=true` with no registry variables; never set
this on a production installation.

B2 requests have a two-second deadline covering headers and response consumption.
The erase job reserves twelve seconds before starting a step (at most four B2
requests); its lease is thirty seconds. If publication fails or its outcome is
uncertain, data stays intact and the job republishes the same sequence and exact
ciphertext, then the head, before proceeding. Retries are after 1 minute, 10
minutes, 1 hour and 6 hours. After five failures the job is `dead`. Restore B2 and
resume **that same job** before accepting further erasures; do not abandon its
allocated sequence. An operator can reset its state to `pending`, attempts to 0,
and run_after to the current epoch milliseconds in the isolated API database.
The job clock runs in the API, independently of panel/browser connections.

Keep genesis, head and **every numbered entry** for the lifetime of the register;
do not apply an age-based lifecycle rule to this prefix. Copies, jobs and panel
state cannot establish its completeness. Restore requires the retained
`TOMBSTONE_REGISTRY_ID`, matching genesis/head, all entries 1..head, and the entire
hash chain. Missing roots, a gap, unknown objects, a head behind the last entry,
or a different register cause refusal before any replay, including with
`--allow-missing`. A delayed old head write may require operator repair from the
retained numbered chain; it must never be treated as a complete shorter register.

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
