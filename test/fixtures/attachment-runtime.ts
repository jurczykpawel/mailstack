import { generateKeyPairSync } from 'node:crypto';
import { startServer } from '../../src/runtime/node-api';
import { createApp } from '../../src/index';
import { config } from '../../src/core/config';
import { createSqliteStore } from '../../src/core/store/sqlite';
import { smtpFromEnv } from '../../src/adapters/sender/smtp';
import { open } from '../../src/core/crypto';
import type { Env } from '../../src/types';

const pair = generateKeyPairSync('x25519');
const publicKey = { ...pair.publicKey.export({ format: 'jwk' }), kty: 'OKP', crv: 'X25519', kid: 'c1' };
const privateKey = { ...pair.privateKey.export({ format: 'jwk' }), kty: 'OKP', crv: 'X25519', kid: 'c1' };
const env = { API_KEY: 'test-key', CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: [publicKey] }),
  INDEX_KEYS: JSON.stringify([{ kid: 'i1', key: Buffer.alloc(32, 11).toString('base64url') }]) } as Env;
config.legacyApiKey = { enabled: true, env: 'API_KEY', brands: '*', templates: '*', recipientOverride: true, attachments: true };
const logging = structuredClone(config.logging);
logging.defaults.level = 'full'; logging.defaults.requireLog = true; logging.defaults.resend = 'replay';
const store = createSqliteStore(':memory:'); await store.migrate();
const app = createApp({ store, logging, provider: 'smtp', sendEmail: smtpFromEnv({ SMTP_HOST: '127.0.0.1', SMTP_PORT: process.env.PROFILE_SMTP_PORT }) });
const sample = () => ({ rss: process.memoryUsage().rss, peakRss: process.resourceUsage().maxRSS * 1024 });
const runtime = await startServer(async (req, env, ctx) => {
  if (new URL(req.url).pathname === '/profile') {
    const archives = [];
    for (const table of ['contents', 'replays'] as const) {
      const purpose = table === 'contents' ? 'content' : 'replay';
      for (const row of await store.db.selectFrom(table).selectAll().execute()) {
        archives.push(await open(row.sealed, { brand: 'acme', messageId: row.message_id, purpose }, [privateKey]));
      }
    }
    return Response.json({ ...sample(), archives });
  }
  return app.fetch(req, env, ctx as ExecutionContext);
}, env, 0);
process.send?.({ port: runtime.port, ...sample() });
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  void runtime.close().then(() => store.db.destroy()).then(() => { if (process.connected) process.disconnect?.(); });
};
process.on('message', close);
process.on('disconnect', close);
