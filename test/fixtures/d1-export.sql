PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(1,'0001_initial.sql','2026-11-03 13:04:29');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(2,'0002_ses_status.sql','2026-11-03 13:04:29');
CREATE TABLE messages (
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
INSERT INTO "messages" ("id","client_id","brand","template","level","policy_hash","status","complained","created_at","sent_at","provider","provider_account","provider_message_id","provider_response_sealed","subject_sealed","ref_idx","ref_sealed","idem_key_hash","request_mac","replay_mac","resend_of","resend_root","attachments_meta","meta_expires_at","content_expires_at") VALUES('msg_1','legacy','acme','payment','full','ph1','sent',0,1762160000000,1762160001000,NULL,NULL,NULL,NULL,'v1.seal''quote',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'{"count":1,"totalBytes":5,"types":["text/plain"]}',1793696000000,NULL);
INSERT INTO "messages" ("id","client_id","brand","template","level","policy_hash","status","complained","created_at","sent_at","provider","provider_account","provider_message_id","provider_response_sealed","subject_sealed","ref_idx","ref_sealed","idem_key_hash","request_mac","replay_mac","resend_of","resend_root","attachments_meta","meta_expires_at","content_expires_at") VALUES('msg_2','public','demo','contact','meta','ph2','send_failed',0,1762160002000,NULL,NULL,NULL,NULL,NULL,'zażółć gęślą jaźń',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,1793696000000,NULL);
CREATE TABLE recipients (
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
INSERT INTO "recipients" ("message_id","pos","role","addr_idx","idx_kid","addr_sealed","addr_hint","status","last_event_at") VALUES('msg_1',0,'to','idx_a','k1','sealed_a','b***@example.com','delivered',1762160005000);
INSERT INTO "recipients" ("message_id","pos","role","addr_idx","idx_kid","addr_sealed","addr_hint","status","last_event_at") VALUES('msg_2',0,'to','idx_b','k1','sealed_b','j***@example.com','sent',NULL);
CREATE TABLE subjects (
  message_id TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('recipient','reply_to','submitter')),
  addr_idx   TEXT NOT NULL,
  idx_kid    TEXT NOT NULL,
  PRIMARY KEY (message_id, role, addr_idx)
);
CREATE TABLE contents (
  message_id TEXT PRIMARY KEY,
  sealed     TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
INSERT INTO "contents" ("message_id","sealed","expires_at") VALUES('msg_1','content-sealed-x',1793696000000);
CREATE TABLE replays (
  message_id TEXT PRIMARY KEY,
  sealed     TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE events (
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
CREATE TABLE guards (
  key        TEXT PRIMARY KEY,
  count      INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE resend_jobs (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL, root TEXT NOT NULL, actor TEXT NOT NULL,
  token TEXT NOT NULL, strategy TEXT NOT NULL, payload_mac TEXT, state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','failed','unknown')),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, result_id TEXT
);
CREATE TABLE audit (
  seq       INTEGER PRIMARY KEY,
  at        INTEGER NOT NULL,
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL,
  target    TEXT,
  details   TEXT,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL
);
CREATE TABLE ses_status (
  id TEXT PRIMARY KEY,
  confirmed_at INTEGER,
  received INTEGER NOT NULL DEFAULT 0,
  rejected_signature INTEGER NOT NULL DEFAULT 0,
  rejected_topic INTEGER NOT NULL DEFAULT 0,
  rejected_account INTEGER NOT NULL DEFAULT 0,
  last_received_at INTEGER,
  last_received_type TEXT
);
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('d1_migrations',2);
CREATE UNIQUE INDEX messages_idem ON messages(client_id, idem_key_hash) WHERE idem_key_hash IS NOT NULL;
CREATE INDEX messages_brand_time ON messages(brand, created_at);
CREATE INDEX messages_status_time ON messages(status, created_at);
CREATE INDEX messages_provider ON messages(provider_account, provider_message_id);
CREATE INDEX messages_ref ON messages(ref_idx);
CREATE INDEX messages_resend_root ON messages(resend_root);
CREATE INDEX messages_meta_exp ON messages(meta_expires_at);
CREATE INDEX recipients_idx ON recipients(addr_idx);
CREATE INDEX subjects_idx ON subjects(addr_idx);
CREATE INDEX contents_exp ON contents(expires_at);
CREATE INDEX replays_exp ON replays(expires_at);
CREATE UNIQUE INDEX events_source ON events(source, source_event_id);
CREATE INDEX events_msg ON events(message_id, occurred_at);
CREATE INDEX guards_exp ON guards(expires_at);
CREATE INDEX resend_jobs_exp ON resend_jobs(expires_at);