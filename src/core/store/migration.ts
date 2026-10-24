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
CREATE INDEX IF NOT EXISTS messages_provider ON messages(provider_account, provider_message_id);
CREATE INDEX IF NOT EXISTS messages_ref ON messages(ref_idx);
CREATE INDEX IF NOT EXISTS messages_resend_root ON messages(resend_root);
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
