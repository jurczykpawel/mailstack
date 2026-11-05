import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv } from './env.ts';
import { CONFIG_JSON } from '../src/core/config/bundled.ts';
import { migrateWorker, remoteStore } from './worker-schema.ts';

if (process.argv[2] !== '--remote') throw new Error('Usage: node scripts/migrate-worker.ts --remote');
const env = loadEnv(process.cwd()), config = JSON.parse(CONFIG_JSON);
const pro = env.MAILSTACK_PRO_PATH ? await import(pathToFileURL(resolve(env.MAILSTACK_PRO_PATH, 'src/worker.ts')).href) : undefined;
const entry = config.extensions?.find((e: { module: string }) => e.module === 'mailstack-pro');
if (entry && !pro) throw new Error('The configuration requires Mailstack Pro');
const store = remoteStore(async command => {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--remote', '--json', '--command', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
});
try { await migrateWorker(store, entry ? pro : undefined, entry?.options); }
finally { await store.db.destroy(); }
