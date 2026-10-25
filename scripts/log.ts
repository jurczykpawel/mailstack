import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { sql } from 'kysely';
import { appendAudit } from '../src/core/audit.ts';
import { blindIndexes, open } from '../src/core/crypto/index.ts';
import { parseIndexKeys, parsePrivateKeys } from '../src/core/keyring.ts';
import { isContentReadable } from '../src/core/retention.ts';
import { createSqliteStore } from '../src/core/store/sqlite.ts';
import type { KyselyStore } from '../src/core/store/index.ts';

class LogReadError extends Error {}
const fail = (message: string): never => { throw new LogReadError(message); };
const usage = () => fail('Usage: mailstack log list|find|show <id> --db <file> [options] [--json]');
const metadata = ['id', 'created_at', 'brand', 'template', 'status'] as const;

function options(args: string[]) {
  const action = args.shift();
  if (!action || !['list', 'find', 'show'].includes(action)) return usage();
  const id = action === 'show' ? args.shift() : undefined;
  if (action === 'show' && (!id || id.startsWith('--'))) return usage();
  const allowed = ['--db', '--json', ...(action === 'list' ? ['--brand', '--status', '--since', '--limit']
    : action === 'find' ? ['--email', '--index-keys'] : ['--key'])];
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!allowed.includes(flag) || values.has(flag)) return usage();
    const value = flag === '--json' ? 'true' : args[++i];
    if (!value || value.startsWith('--')) return usage();
    values.set(flag, value);
  }
  const required = (flag: string) => values.get(flag) ?? usage();
  const filename = required('--db');
  if (action === 'show') required('--key');
  if (action === 'find') { required('--email'); required('--index-keys'); }
  const limit = Number(values.get('--limit') ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('Limit must be an integer from 1 to 100');
  const since = values.get('--since');
  if (since && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(since) || !Number.isFinite(Date.parse(since))))
    fail('Since must be an ISO timestamp with a timezone');
  return { action, id, filename, values, limit, since };
}

function keyData(filename: string): string {
  try { return readFileSync(filename, 'utf8'); }
  catch { return fail('Invalid key configuration'); }
}

async function show(store: KyselyStore, id: string, filename: string, keyFile: string) {
  const message = await store.db.selectFrom('messages').select([...metadata, 'level', 'policy_hash', 'sent_at', 'complained',
    'client_id', 'provider', 'provider_message_id', 'content_expires_at']).where('id', '=', id).executeTakeFirst();
  if (!message) return fail('Message not found (level none does not record messages)');
  if (!['meta', 'masked', 'full'].includes(message.level) || !/^[a-f0-9]{16}$/.test(message.policy_hash)) return fail('Logging policy unavailable');
  const events = (await sql`select type,occurred_at,received_at,source,auth,summary,recipient_pos
    from events where message_id=${id} order by occurred_at,id`.execute(store.db)).rows;
  if (message.level === 'meta') return { message, events, contentNotice: 'Content not recorded by logging policy (meta)' };
  const content = await store.db.selectFrom('contents').selectAll().where('message_id', '=', id).executeTakeFirst();
  const now = Date.now();
  if (!isContentReadable(content, now) || !isContentReadable({ expires_at: message.content_expires_at ?? 0 }, now))
    return fail('Archived content expired or unavailable');
  let keys;
  try { keys = parsePrivateKeys(keyData(keyFile)); }
  catch { return fail('Invalid key configuration'); }
  const provider = await store.db.selectFrom('messages').select('provider_response_sealed').where('id', '=', id).executeTakeFirstOrThrow();
  let writer: KyselyStore | undefined;
  try {
    writer = createSqliteStore(new Database(filename, { fileMustExist: true }));
    await appendAudit(writer, { at: now, actor: 'cli', action: 'cli.read', target: id });
  } catch { return fail('Audit append unavailable; content was not opened'); }
  finally { await writer?.db.destroy(); }
  if (!isContentReadable(content, Date.now()) || !isContentReadable({ expires_at: message.content_expires_at ?? 0 }, Date.now()))
    return fail('Archived content expired or unavailable');
  try {
    const context = { brand: message.brand, messageId: id };
    const contentValue = await open(content!.sealed, { ...context, purpose: 'content' }, keys);
    const providerResponse = provider.provider_response_sealed
      ? await open(provider.provider_response_sealed, { ...context, purpose: 'provider_response' }, keys) : null;
    return { message, events, archiveLabel: `Archived projection (level ${message.level})`, content: contentValue, providerResponse };
  } catch { return fail('Unable to open content; check the private key and kid'); }
}

export async function readLog(args: string[]): Promise<void> {
  let store: KyselyStore | undefined;
  try {
    const { action, id, filename, values, limit, since } = options([...args]);
    try { store = createSqliteStore(new Database(filename, { readonly: true, fileMustExist: true })); }
    catch { return fail('Unable to open log database'); }
    if (action === 'show') {
      const detail = await show(store, id!, filename, values.get('--key')!);
      process.stdout.write(JSON.stringify(detail, null, 2) + '\n');
      return;
    }
    let query = store.db.selectFrom('messages').select(metadata)
      .select(sql<string | null>`(select type from events where message_id=messages.id order by occurred_at desc,id desc limit 1)`.as('last_event'));
    if (values.has('--brand')) query = query.where('brand', '=', values.get('--brand')!);
    if (values.has('--status')) query = query.where(sql<string>`status`, '=', values.get('--status')!);
    if (since) query = query.where('created_at', '>=', Date.parse(since));
    if (action === 'find') {
      let indexes;
      try {
        const source = values.get('--index-keys')!;
        const keys = parseIndexKeys(source === 'env' ? process.env.INDEX_KEYS ?? '' : keyData(source));
        indexes = await blindIndexes(values.get('--email')!, keys);
      } catch { return fail('Invalid key configuration or email'); }
      query = query.where(eb => eb.exists(eb.selectFrom('subjects').select('message_id')
        .whereRef('subjects.message_id', '=', 'messages.id')
        .where(eb => eb.or(indexes.map(idx => eb.and([eb('idx_kid', '=', idx.kid), eb('addr_idx', '=', idx.index)]))))));
    }
    const rows = (await query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit).execute())
      .map(row => ({ ...row, created_at: new Date(row.created_at).toISOString() }));
    if (values.has('--json')) process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    else console.table(rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
      [key, typeof value === 'string' ? JSON.stringify(value).slice(1, -1) : value]))));
  } catch (error) {
    throw new Error(error instanceof LogReadError ? error.message : 'Unable to read log database');
  } finally { await store?.db.destroy(); }
}
