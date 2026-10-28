import { readFileSync } from 'node:fs';
import { loadConfig } from '../../src/core/config/load';
import { createSqliteStore } from '../../src/core/store/sqlite';
import { createApp } from '../../src/index';
import { startServer } from '../../src/runtime/node-api';
import { smtpFromEnv } from '../../src/adapters/sender/smtp';
import type { Env } from '../../src/types';

const cfg = loadConfig(readFileSync(process.argv[2], 'utf8'));
const store = createSqliteStore(process.argv[3]);
await store.migrate();
const sender = smtpFromEnv(process.env);
const app = createApp({ store, logging: cfg.logging, sendEmail: sender, provider: 'smtp' });
const env: Env = { ...process.env, API_KEY: process.env.API_KEY ?? '', SES_REGION: '', SES_ACCESS_KEY_ID: '',
  SES_SECRET_ACCESS_KEY: '', TURNSTILE_SECRET: '', ALTCHA_HMAC_KEY: '' };
const server = await startServer((req, env, ctx) => app.fetch(req, env, ctx as ExecutionContext), env, 0);
process.send?.({ port: server.port });
