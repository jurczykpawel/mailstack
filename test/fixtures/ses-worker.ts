import { sql } from 'kysely';
import { createD1Store } from '../../src/core/store/d1';
import { createVerifier } from '../../src/events/sns';
import { handleSesEvent } from '../../src/events/ses';
import { options } from '../sns-fixture-options';
interface Env { DB: D1Database; CERT: string; KEYS: string; INDICES: string; INDEX_KEYS: string }
let initialized = false;
export default { async fetch(req: Request, env: Env) {
  const store = createD1Store(env.DB);
  if (!initialized) {
    await store.migrate();
    await sql`insert into messages(id,client_id,brand,template,level,policy_hash,status,created_at,meta_expires_at,provider_account,provider_message_id)
      values('msg_1','demo','acme','notice','meta','hash','sending',0,9999999999999,'123456789012','provider-1')`.execute(store.db);
    for (const [pos, idx] of (JSON.parse(env.INDICES) as { index: string }[]).entries())
      await sql`insert into recipients values('msg_1',${pos},'to',${idx.index},'i1','sealed','hint','sending',null)`.execute(store.db);
    initialized = true;
  }
  const path = new URL(req.url).pathname;
  if (path.startsWith('/rows/')) return Response.json((await sql`select * from ${sql.table(path.slice(6))}`.execute(store.db)).rows);
  return handleSesEvent(req, { options, store, verify: createVerifier(async () => new Response(env.CERT)),
    contentKeys: req.headers.has('test-no-keys') ? [] : JSON.parse(env.KEYS), indexKeys: JSON.parse(env.INDEX_KEYS), now: () => Date.now(), fetcher: async () => new Response(env.CERT) });
} };
