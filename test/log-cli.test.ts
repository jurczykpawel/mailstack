import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { sql } from 'kysely';
import example from '../config/mailstack.example.json';
import { parseConfig } from '../src/core/config/schema';
import { createSqliteStore } from '../src/core/store/sqlite';
import { recordIntent } from '../src/core/logging/writer';
import { seal } from '../src/core/crypto';
import { appendAudit, verifyChain } from '../src/core/audit';
import type { AuditRow } from '../src/core/audit';
import { TEMPLATES } from '../src/templates/index';

let dir: string, db: string, keyFile: string, indexFile: string;
let ids: Record<string, string>;
const indexKeys = [{ kid: 'new', key: Buffer.alloc(32, 12).toString('base64url') },
  { kid: 'old', key: Buffer.alloc(32, 11).toString('base64url') }];
const cli = (args: string[], env = process.env) => spawnSync(process.execPath, ['scripts/mailstack.ts', 'log', ...args], { encoding: 'utf8', env });
const run = (...args: string[]) => cli([...args, '--db', db, '--json']);
const show = (level = 'full', key = keyFile) => run('show', ids[level], '--key', key);
const audit = (): AuditRow[] => {
  const connection = new Database(db, { readonly: true });
  try { return connection.prepare('select * from audit order by seq').all() as AuditRow[]; }
  finally { connection.close(); }
};
const mutate = (query: string) => {
  const connection = new Database(db);
  try { connection.exec(query); } finally { connection.close(); }
};
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mailstack-log-'));
  db = join(dir, 'log.sqlite'); keyFile = join(dir, 'content-private.json'); indexFile = join(dir, 'index.json');
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const publicKey = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'content' };
  const privateKey = { ...await crypto.subtle.exportKey('jwk', pair.privateKey), kid: 'content' };
  writeFileSync(keyFile, JSON.stringify({ keys: [privateKey] }));
  writeFileSync(indexFile, JSON.stringify(indexKeys));
  const store = createSqliteStore(db);
  ids = {};
  try {
    await store.migrate();
    const config = parseConfig(example);
    const now = Date.now() - 60000;
    for (const [i, level] of (['none', 'meta', 'masked', 'full'] as const).entries()) {
      const logging = structuredClone(config.logging);
      logging.defaults.level = level;
      logging.defaults.show = ['name'];
      const brand = config.brands[level === 'meta' ? 'demo' : 'acme'];
      const { id } = await recordIntent({ store, logging, now: () => new Date(now + i),
        env: { CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: [publicKey] }), INDEX_KEYS: JSON.stringify([indexKeys[i % 2]]) } },
      { clientId: 'acme-app', brand, template: TEMPLATES.contact,
        recipients: [{ role: 'to', address: `${level}@example.com` }], replyTo: 'reply@example.com',
        data: { name: 'Archive name', email: 'submitter@example.com', message: 'Archive body sentinel' } });
      if (!id) continue;
      ids[level] = id;
      await store.markSent(id, { providerMessageId: `provider-${level}`, sentAt: now + i + 10,
        providerResponseSealed: await seal({ response: 'Provider response sentinel' }, { brand: brand.id, messageId: id, purpose: 'provider_response' }, [publicKey]) });
    }
    for (const [i, type] of ['delivered', 'bounce_permanent', 'complaint'].entries()) {
      await sql`insert into events(id,message_id,source,source_event_id,type,occurred_at,received_at,auth,summary)
        values (${`event-${i}`},${ids.full},'local',${`source-${i}`},${type},${now + 100 + i},${now + 200 + i},'local','Event summary')`.execute(store.db);
    }
    await appendAudit(store, { at: now, actor: 'system', action: 'fixture' });
  } finally { await store.db.destroy(); }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('lists stored levels without addresses and reports the latest event', () => {
  const result = run('list');
  expect(result.status, result.stderr).toBe(0);
  const rows = JSON.parse(result.stdout);
  expect(rows.map((row: { id: string }) => row.id)).toEqual([ids.full, ids.masked, ids.meta]);
  expect(rows[0]).toMatchObject({ brand: 'acme', template: 'contact', status: 'sent', last_event: 'complaint' });
  expect(result.stdout).not.toContain('@');
  expect(result.stdout).not.toContain('sealed');
  expect(audit()).toHaveLength(1);
  const table = cli(['list', '--db', db]);
  expect(table.status, table.stderr).toBe(0);
  for (const label of ['id', 'created_at', 'brand', 'template', 'status', 'last_event']) expect(table.stdout).toContain(label);
  expect(table.stdout).not.toContain('@');
});
it('filters list rows and bounds its limit', () => {
  expect(JSON.parse(run('list', '--brand', 'demo', '--status', 'sent', '--since', '2020-01-01T00:00:00Z').stdout).map((r: { id: string }) => r.id)).toEqual([ids.meta]);
  expect(JSON.parse(run('list', '--limit', '1').stdout)).toHaveLength(1);
  expect(JSON.parse(run('list', '--status', 'delivered').stdout)).toEqual([]);
  expect(JSON.parse(run('list', '--since', '2099-01-01T00:00:00Z').stdout)).toEqual([]);
  for (const args of [['--limit', '0'], ['--limit', '101'], ['--limit', '1.5'], ['--since', 'yesterday'], ['--brand'], ['--db', db], ['--unknown', 'x']]) {
    const result = run('list', ...args);
    expect(result.status).toBe(1); expect(result.stdout).toBe('');
  }
});
it('finds addresses through all index generations and all subject roles', () => {
  for (const level of ['meta', 'masked', 'full']) {
    const result = run('find', '--email', ` ${level}@EXAMPLE.COM `, '--index-keys', indexFile);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).map((r: { id: string }) => r.id)).toEqual([ids[level]]);
    expect(result.stdout).not.toContain('@');
  }
  for (const email of ['reply@example.com', 'submitter@example.com']) {
    const result = cli(['find', '--db', db, '--email', email, '--index-keys', 'env', '--json'], { ...process.env, INDEX_KEYS: JSON.stringify(indexKeys) });
    expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toHaveLength(3);
  }
  expect(JSON.parse(run('find', '--email', 'Full@example.com', '--index-keys', indexFile).stdout)).toEqual([]);
  expect(JSON.parse(run('find', '--email', 'none@example.com', '--index-keys', indexFile).stdout)).toEqual([]);
  expect(audit()).toHaveLength(1);
});
it('shows the archived projection and provider response after recording cli.read', () => {
  for (const level of ['masked', 'full']) {
    const result = show(level);
    expect(result.status, result.stderr).toBe(0);
    const detail = JSON.parse(result.stdout);
    expect(detail.message).toMatchObject({ id: ids[level], level });
    expect(detail.archiveLabel).toBe(`Archived projection (level ${level})`);
    expect(detail.providerResponse).toEqual({ response: 'Provider response sentinel' });
    expect(result.stdout.includes('Archive body sentinel')).toBe(level === 'full');
    expect(result.stderr).toBe('');
  }
  expect(JSON.parse(show().stdout).events.map((event: { type: string }) => event.type)).toEqual(['delivered', 'bounce_permanent', 'complaint']);
  const chain = audit();
  expect(chain.slice(1).every(row => row.action === 'cli.read' && row.actor === 'cli')).toBe(true);
  expect(chain[1].target).toBe(ids.masked);
  expect(verifyChain(chain)).toBe(true);
  expect(JSON.stringify(chain)).not.toContain('sentinel');
});
it('returns metadata and a clear policy notice for meta without decrypting', () => {
  const result = show('meta');
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).contentNotice).toContain('meta');
  expect(result.stdout).not.toContain('Provider response sentinel');
  expect(audit()).toHaveLength(1);
});
it('refuses unavailable or expired content and invalid policy metadata', () => {
  for (const query of [
    `update contents set expires_at=0 where message_id='${ids.full}'`,
    `update messages set content_expires_at=0 where id='${ids.full}'`,
    `update messages set policy_hash='' where id='${ids.full}'`,
    `delete from contents where message_id='${ids.full}'`,
  ]) {
    mutate(query);
    const result = show();
    expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toMatch(/policy|expired|unavailable/i);
  }
  expect(audit()).toHaveLength(1);
});
it('reports wrong keys and kids without partial output and preserves the audit chain', async () => {
  const valid = JSON.parse(readFileSync(keyFile, 'utf8'));
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const wrong = { ...await crypto.subtle.exportKey('jwk', pair.privateKey), kid: 'content' };
  for (const keys of [[wrong], [{ ...valid.keys[0], kid: 'other' }]]) {
    writeFileSync(keyFile, JSON.stringify({ keys }));
    const result = show();
    expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toContain('Unable to open content');
    expect(result.stderr).not.toContain(wrong.d); expect(result.stderr).not.toContain('sentinel'); expect(result.stderr).not.toContain(' at ');
  }
  expect(audit()).toHaveLength(3); expect(verifyChain(audit())).toBe(true);
});
it('requires a successful audit append before attempting decryption', () => {
  mutate("CREATE TRIGGER refuse_read BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'Audit fixture sentinel'); END");
  const result = show();
  expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toContain('Audit append unavailable');
  expect(result.stderr).not.toContain('fixture sentinel'); expect(audit()).toHaveLength(1);
});
it('reports absent databases and key files without creating files or printing paths', () => {
  const missing = join(dir, 'absent.sqlite');
  const result = cli(['list', '--db', missing]);
  expect(result.status).toBe(1); expect(result.stderr).toContain('Unable to open log database');
  expect(result.stderr).not.toContain(dir); expect(existsSync(missing)).toBe(false);
  const absentKey = show('full', join(dir, 'absent.json'));
  expect(absentKey.status).toBe(1); expect(absentKey.stdout).toBe(''); expect(absentKey.stderr).toContain('Invalid key configuration');
  expect(absentKey.stderr).not.toContain(dir);
});
it('validates key files, env selections and command usage', () => {
  writeFileSync(indexFile, 'invalid-key-sentinel');
  for (const args of [[], ['unknown'], ['show'], ['show', ids.full], ['find'],
    ['find', '--email', 'full@example.com', '--index-keys', indexFile],
    ['find', '--email', 'full@example.com', '--index-keys', 'env'], ['show', ids.full, '--key', indexFile]]) {
    const result = cli([...args, '--db', db], { ...process.env, INDEX_KEYS: '' });
    expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).not.toContain('invalid-key-sentinel');
    expect(result.stderr).not.toContain(' at ');
  }
  expect(audit()).toHaveLength(1);
});
