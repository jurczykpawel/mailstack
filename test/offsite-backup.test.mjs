import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Encrypter, generateIdentity, identityToRecipient } from 'age-encryption';
import { INITIAL_SCHEMA, SES_STATUS_SCHEMA } from '../src/core/store/migration';
import { backupSqlite } from '../src/core/store/backup';
import { d1Export, exportBackup, sourceFrom } from '../scripts/backup/export.mjs';
import { restoreBackup } from '../scripts/backup/restore.mjs';

const fixture = fileURLToPath(new URL('./fixtures/d1-export.sql', import.meta.url));
const temp = () => mkdtempSync(join(tmpdir(), 'ms-backup-'));
const tables = db => Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all())
  .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
const read = path => { const db = new Database(path, { readonly: true }); try { return tables(db); } finally { db.close(); } };
const keys = async () => { const identity = await generateIdentity(); return { identity, recipient: await identityToRecipient(identity) }; };
const capture = () => { const sent = {}; return { sent, put: async (key, body) => Object.assign(sent, { key, body }) }; };
const fromD1 = async recipient => { const { sent, put } = capture(); await exportBackup({ recipient, d1: 'mailstack', exportD1: async () => readFileSync(fixture), put }); return sent.body; };
const d1Target = (tablesInUse, calls) => args => {
  calls.push(args); if (args.includes('--file')) calls.push([readFileSync(args[args.indexOf('--file') + 1], 'utf8')]);
  return JSON.stringify([{ results: [{ n: tablesInUse }], success: true }]);
};

describe('offsite backup', () => {
  it('restores the newest Node snapshot into a new SQLite file with identical rows', async () => {
    const { identity, recipient } = await keys(); const dir = temp();
    const live = new Database(join(dir, 'live.db')); live.exec(INITIAL_SCHEMA + SES_STATUS_SCHEMA);
    live.prepare("INSERT INTO contents VALUES ('msg_1', 'zażółć ''sealed''', 42)").run();
    await backupSqlite(live, join(dir, 'snapshots'), Date.UTC(2026, 10, 3));
    const { sent, put } = capture(); await exportBackup({ recipient, sqliteDir: join(dir, 'snapshots'), put });
    expect(sent.key).toMatch(/^mailstack\/mailstack-20261103\.db\.age$/);
    expect(Buffer.from(sent.body).includes('zażółć')).toBe(false);
    await restoreBackup({ input: sent.body, identity, sqlite: join(dir, 'restored.db') });
    expect(read(join(dir, 'restored.db'))).toEqual(tables(live));
  });

  it('restores a recorded D1 export into a new SQLite file without changing rows', async () => {
    const { identity, recipient } = await keys(); const target = join(temp(), 'restored.db');
    await restoreBackup({ input: await fromD1(recipient), identity, sqlite: target });
    const direct = new Database(':memory:'); direct.exec(readFileSync(fixture, 'utf8'));
    const restored = read(target); expect(restored).toEqual(tables(direct));
    expect(restored.messages.map(row => row.subject_sealed)).toEqual(["v1.seal'quote", 'zażółć gęślą jaźń']);
    expect([restored.recipients.length, restored.contents.length, restored.d1_migrations.length]).toEqual([2, 1, 2]);
  });

  it('imports into an empty D1 database and refuses one with tables', async () => {
    const { identity, recipient } = await keys(); const input = await fromD1(recipient);
    const empty = []; await restoreBackup({ input, identity, d1: 'restore-1', wrangler: d1Target(0, empty) });
    expect(empty[1].slice(0, 4)).toEqual(['d1', 'execute', 'restore-1', '--remote']);
    expect(empty[2][0]).toBe(readFileSync(fixture, 'utf8'));
    const used = [];
    await expect(restoreBackup({ input, identity, d1: 'mailstack', wrangler: d1Target(3, used) })).rejects.toThrow(/not empty/);
    expect(used.some(args => args.includes('--file'))).toBe(false);
  });

  it('refuses an existing SQLite target, a missing or wrong key and a damaged file', async () => {
    const { identity, recipient } = await keys(); const input = await fromD1(recipient); const dir = temp();
    writeFileSync(join(dir, 'used.db'), 'in use');
    await expect(restoreBackup({ input, identity, sqlite: join(dir, 'used.db') })).rejects.toThrow();
    expect(readFileSync(join(dir, 'used.db'), 'utf8')).toBe('in use');
    const damaged = input.slice(); damaged[damaged.length - 5] ^= 1;
    for (const [bytes, key] of [[damaged, identity], [input, (await keys()).identity]]) {
      await expect(restoreBackup({ input: bytes, identity: key, sqlite: join(dir, 'new.db') })).rejects.toThrow();
      expect(existsSync(join(dir, 'new.db'))).toBe(false);
    }
    const broken = new Encrypter(); broken.addRecipient(recipient);
    await expect(restoreBackup({ input: await broken.encrypt('CREATE TABLE a (x); INSERT INTO missing VALUES (1);'), identity, sqlite: join(dir, 'new.db') })).rejects.toThrow(/missing/);
    expect(existsSync(join(dir, 'new.db'))).toBe(false);
    await expect(restoreBackup({ input, identity: undefined, sqlite: join(dir, 'new.db') })).rejects.toThrow(/age identity is required/);
    const { sent, put } = capture(); let exported = false;
    await expect(exportBackup({ recipient: '', d1: 'mailstack', exportD1: async () => { exported = true; return Buffer.from(''); }, put })).rejects.toThrow(/age recipient \(age1/);
    expect([exported, sent.body]).toEqual([false, undefined]);
    await expect(exportBackup({ recipient, sqliteDir: temp(), put })).rejects.toThrow(/snapshot/);
  });

  // Shapes recorded from the Cloudflare API on the staging account (2026-11-04): active with a bookmark, then complete with a signed URL.
  const cloudflare = (steps, dump = new Response(readFileSync(fixture))) => {
    const calls = []; let at = 0;
    const fetch = async (url, init) => {
      calls.push({ url, body: init.body && JSON.parse(init.body), auth: init.headers?.authorization });
      return url === 'https://signed.example/dump.sql' ? dump : Response.json(steps[at++], { status: steps[at - 1].http ?? 200 });
    };
    return { calls, fetch };
  };
  const active = { success: true, result: { success: true, type: 'export', at_bookmark: 'b1', status: 'active' } };
  const complete = { success: true, result: { success: true, type: 'export', at_bookmark: 'b1', status: 'complete', result: { filename: 'x.sql', signed_url: 'https://signed.example/dump.sql' } } };
  const creds = { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'demo-token' }, wait = async () => {};

  it('exports D1 through the API without Wrangler: start, poll the bookmark, download the signed dump', async () => {
    const api = cloudflare([active, complete]);
    const bytes = await d1Export('db-1', creds, { fetch: api.fetch, wait });
    expect(bytes.toString('utf8')).toBe(readFileSync(fixture, 'utf8'));
    expect(api.calls.map(c => c.url)).toEqual([...Array(2).fill('https://api.cloudflare.com/client/v4/accounts/acct/d1/database/db-1/export'), 'https://signed.example/dump.sql']);
    expect(api.calls.slice(0, 2).map(c => c.body)).toEqual([{ output_format: 'polling' }, { output_format: 'polling', current_bookmark: 'b1' }]);
    expect(api.calls[0].auth).toBe('Bearer demo-token');
    const { identity, recipient } = await keys(); const { sent, put } = capture(); const target = join(temp(), 'restored.db');
    await exportBackup({ recipient, d1: 'db-1', put, exportD1: database => d1Export(database, creds, { fetch: cloudflare([complete]).fetch, wait }) });
    await restoreBackup({ input: sent.body, identity, sqlite: target });
    expect(read(target).messages).toHaveLength(2);
  });

  it('refuses D1 copies without credentials, with an API error, a failed export or download, and never uploads', async () => {
    const failing = [[{ http: 403, success: false, errors: [{ code: 10000 }] }], [{ success: true, result: { at_bookmark: 'b1', status: 'error', error: 'export failed' } }], [{ success: true, result: { status: 'active' } }]];
    for (const steps of failing) await expect(d1Export('db-1', creds, { fetch: cloudflare(steps).fetch, wait })).rejects.toThrow(/^D1 export failed: (HTTP 403|HTTP 200 export failed|no bookmark)$/);
    await expect(d1Export('db-1', creds, { fetch: cloudflare([complete], new Response('', { status: 403 })).fetch, wait })).rejects.toThrow(/download failed/);
    await expect(d1Export('db-1', creds, { fetch: cloudflare([active, active, active]).fetch, wait, polls: 2 })).rejects.toThrow(/did not finish/);
    const none = cloudflare([complete]);
    await expect(d1Export('db-1', { CLOUDFLARE_ACCOUNT_ID: 'acct' }, { fetch: none.fetch, wait })).rejects.toThrow(/CLOUDFLARE_API_TOKEN/);
    expect(none.calls).toHaveLength(0);
    const { recipient } = await keys(); const { sent, put } = capture();
    await expect(exportBackup({ recipient, d1: 'db-1', put, exportD1: database => d1Export(database, creds, { fetch: cloudflare(failing[1]).fetch, wait }) })).rejects.toThrow();
    expect(sent.body).toBeUndefined();
  });

  it('takes the source from flags or explicitly from BACKUP_SOURCE, never by guessing', () => {
    expect(sourceFrom({}, { BACKUP_SOURCE: 'd1', BACKUP_D1_ID: 'db-1' })).toEqual({ d1: 'db-1' });
    expect(sourceFrom({}, { BACKUP_SOURCE: 'sqlite' })).toEqual({ sqliteDir: '/data/backups' });
    expect(sourceFrom({ 'sqlite-dir': '/x' }, { BACKUP_SOURCE: 'd1' })).toEqual({ d1: undefined, sqliteDir: '/x' });
    for (const env of [{}, { BACKUP_SOURCE: 'D1' }, { BACKUP_D1_ID: 'db-1' }, { BACKUP_SOURCE: 'd1' }]) expect(() => sourceFrom({}, env)).toThrow(/BACKUP_SOURCE/);
  });
});
