export const INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id                      TEXT PRIMARY KEY,
  client_id               TEXT NOT NULL,
  brand                   TEXT NOT NULL,
  template                TEXT NOT NULL,
  level                   TEXT NOT NULL CHECK (level IN ('meta','masked','full')),
  policy_hash             TEXT NOT NULL,
  status                  TEXT NOT NULL,
  complained              INTEGER NOT NULL DEFAULT 0,
  created_at              INTEGER NOT NULL,
  sent_at                 INTEGER,
  provider                TEXT,
  provider_account        TEXT,
  provider_message_id     TEXT,
  provider_response_sealed TEXT,
  subject_sealed          TEXT,
  ref_idx                 TEXT,
  ref_sealed              TEXT,
  idem_key_hash           TEXT,
  request_mac             TEXT,
  replay_mac              TEXT,
  resend_of               TEXT,
  resend_root             TEXT,
  attachments_meta        TEXT,
  meta_expires_at         INTEGER NOT NULL,
  content_expires_at      INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_idem ON messages(client_id, idem_key_hash) WHERE idem_key_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_brand_time ON messages(brand, created_at);
CREATE INDEX IF NOT EXISTS messages_status_time ON messages(status, created_at);
CREATE INDEX IF NOT EXISTS messages_provider_set ON messages(provider_account, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_ref_set ON messages(ref_idx) WHERE ref_idx IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_resend_root_set ON messages(resend_root) WHERE resend_root IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_meta_exp ON messages(meta_expires_at);

CREATE TABLE IF NOT EXISTS recipients (
  message_id    TEXT NOT NULL,
  pos           INTEGER NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('to','cc','bcc')),
  addr_idx      TEXT NOT NULL,
  idx_kid       TEXT NOT NULL,
  addr_sealed   TEXT NOT NULL,
  addr_hint     TEXT NOT NULL,
  status        TEXT NOT NULL,
  last_event_at INTEGER,
  PRIMARY KEY (message_id, pos)
);
CREATE INDEX IF NOT EXISTS recipients_idx ON recipients(addr_idx);

CREATE TABLE IF NOT EXISTS subjects (
  message_id TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('recipient','reply_to','submitter')),
  addr_idx   TEXT NOT NULL,
  idx_kid    TEXT NOT NULL,
  PRIMARY KEY (message_id, role, addr_idx)
);
CREATE INDEX IF NOT EXISTS subjects_idx ON subjects(addr_idx);

CREATE TABLE IF NOT EXISTS contents (
  message_id TEXT PRIMARY KEY,
  sealed     TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS contents_exp ON contents(expires_at);

CREATE TABLE IF NOT EXISTS replays (
  message_id TEXT PRIMARY KEY,
  sealed     TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS replays_exp ON replays(expires_at);

CREATE TABLE IF NOT EXISTS events (
  id               TEXT PRIMARY KEY,
  message_id       TEXT NOT NULL,
  recipient_pos    INTEGER,
  source           TEXT NOT NULL,
  source_event_id  TEXT NOT NULL,
  type             TEXT NOT NULL,
  occurred_at      INTEGER NOT NULL,
  received_at      INTEGER NOT NULL,
  auth             TEXT NOT NULL,
  summary          TEXT,
  evidence_sealed  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS events_source ON events(source, source_event_id);
CREATE INDEX IF NOT EXISTS events_msg ON events(message_id, occurred_at);

CREATE TABLE IF NOT EXISTS guards (
  key        TEXT PRIMARY KEY,
  count      INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS guards_exp ON guards(expires_at);

CREATE TABLE IF NOT EXISTS resend_jobs (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL, root TEXT NOT NULL, actor TEXT NOT NULL,
  token TEXT NOT NULL, strategy TEXT NOT NULL, payload_mac TEXT, state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','failed','unknown')),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, result_id TEXT
);
CREATE INDEX IF NOT EXISTS resend_jobs_exp ON resend_jobs(expires_at);

CREATE TABLE IF NOT EXISTS audit (
  seq       INTEGER PRIMARY KEY,
  at        INTEGER NOT NULL,
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL,
  target    TEXT,
  details   TEXT,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL
);
`;

export const SES_STATUS_SCHEMA = `
CREATE TABLE IF NOT EXISTS ses_status (
  id TEXT PRIMARY KEY,
  confirmed_at INTEGER,
  received INTEGER NOT NULL DEFAULT 0,
  rejected_signature INTEGER NOT NULL DEFAULT 0,
  rejected_topic INTEGER NOT NULL DEFAULT 0,
  rejected_account INTEGER NOT NULL DEFAULT 0,
  last_received_at INTEGER,
  last_received_type TEXT
);
`;

export const JOBS_SCHEMA = `
CREATE TABLE IF NOT EXISTS erasure_registry (
  seq INTEGER PRIMARY KEY, job TEXT NOT NULL UNIQUE, sealed TEXT NOT NULL, hash TEXT NOT NULL, confirmed INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('pending','running','done','dead')),
  cursor      TEXT,
  payload     TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  token       TEXT,
  lease_until INTEGER,
  run_after   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  done_at     INTEGER,
  result      TEXT
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state, run_after);
CREATE INDEX IF NOT EXISTS jobs_done ON jobs(done_at) WHERE done_at IS NOT NULL;
`;

/** Extension schema ledger (one row per applied extension migration) and reconcile state per extension. */
export const EXT_SCHEMA = `
CREATE TABLE IF NOT EXISTS ext_migrations (
  extension TEXT NOT NULL,
  version   INTEGER NOT NULL,
  name      TEXT NOT NULL,
  checksum  TEXT NOT NULL,
  PRIMARY KEY (extension, version)
);
CREATE TABLE IF NOT EXISTS ext_reconcile (
  extension  TEXT PRIMARY KEY,
  config_sha TEXT NOT NULL,
  generation INTEGER NOT NULL,
  cursor     TEXT,
  done_at    INTEGER
);
`;

/** Durable domain events (one row per state-change cause) with per-extension fan-out cursors and recorded gaps (A 3.3). */
export const EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS domain_events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  cause      TEXT NOT NULL UNIQUE,
  type       TEXT NOT NULL,
  message_id TEXT NOT NULL,
  brand      TEXT NOT NULL,
  template   TEXT NOT NULL,
  status     TEXT NOT NULL,
  at         INTEGER NOT NULL,
  ref_digest TEXT
);
CREATE INDEX IF NOT EXISTS domain_events_msg ON domain_events(message_id);
CREATE INDEX IF NOT EXISTS domain_events_at ON domain_events(at);
CREATE TABLE IF NOT EXISTS ext_event_cursor (
  extension TEXT PRIMARY KEY,
  seq       INTEGER NOT NULL DEFAULT 0,
  partial   TEXT
);
CREATE TABLE IF NOT EXISTS ext_event_gaps (
  extension TEXT NOT NULL,
  from_seq  INTEGER NOT NULL,
  to_seq    INTEGER NOT NULL,
  count     INTEGER NOT NULL,
  at        INTEGER NOT NULL,
  PRIMARY KEY (extension, from_seq)
);
`;

/** Columns empty on most sends are indexed only when set (one index write less per insert each); queries compare them with `=`/`IN`. */
export const PARTIAL_INDEX_SCHEMA = `
DROP INDEX IF EXISTS messages_provider;
DROP INDEX IF EXISTS messages_ref;
DROP INDEX IF EXISTS messages_resend_root;
${INITIAL_SCHEMA.split('\n').filter(line => line.includes('_set ON messages')).join('\n')}
`;
