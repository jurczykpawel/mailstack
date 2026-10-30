import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, generateKeyPairSync, createHash } from 'node:crypto';
import { build } from 'esbuild';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const state = resolve(process.env.MAILSTACK_STAGING_STATE ?? `${process.env.HOME}/.config/mailstack-staging/worker`);
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const name = 'mailstack-staging', hostname = 'mailstack-test.techskills.academy';
const command = process.argv[2] ?? 'status';
const delivery = process.env.MAILSTACK_STAGING_DELIVERY ?? 'disabled';
if (!['disabled', 'ses'].includes(delivery)) throw new Error('Delivery must be disabled or ses');
if (!account || !['deploy', 'status', 'destroy'].includes(command)) throw new Error('Set CLOUDFLARE_ACCOUNT_ID; use deploy|status|destroy');
if (state.startsWith(root + '/')) throw new Error('State must be outside the source directory');
process.umask(0o077); mkdirSync(state, { recursive: true, mode: 0o700 });
const put = (file, value) => writeFileSync(`${state}/${file}`, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const token = process.env.CLOUDFLARE_API_TOKEN ?? execFileSync('bw', ['get', 'password', 'CF Deploy - General API token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function api(path, method = 'GET', body) {
  const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000),
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(`Cloudflare ${method} ${path}: ${response.status} ${JSON.stringify(data.errors)}`);
  return data.result;
}
const base = `/accounts/${account}`, script = `${base}/workers/scripts/${name}`;
async function fingerprint() { return digest(canonical(await api(`${base}/workers/scripts/mailstack/deployments`))); }
let sequence = 0;
async function mutate(label, path, method, body) {
  const before = await fingerprint(); let result;
  try { result = await api(path, method, body); }
  finally {
    const after = await fingerprint();
    put(`mutation-${Date.now()}-${++sequence}.json`, { label, before, after, identical: before === after });
    if (before !== after) throw new Error('Production fingerprint changed; stop');
  }
  console.log(`${label}: production IDENTICAL`); return result;
}
const databases = await api(`${base}/d1/database`);
let database = databases.find(value => value.name === name);
const domains = await api(`${base}/workers/domains`);
const domain = domains.find(value => value.hostname === hostname);
if (domain && domain.service !== name) throw new Error('Staging hostname is already assigned to another service');
if (command === 'status') {
  console.log(JSON.stringify({ name, hostname, database: database?.uuid, domain: domain?.service, production: await fingerprint() }, null, 2));
} else if (command === 'destroy') {
  const record = JSON.parse(readFileSync(`${state}/resources.json`));
  if (record.account !== account || record.name !== name || database && record.database !== database.uuid) throw new Error('Resource identity differs from local record');
  if (domain) await mutate('remove-domain', `${base}/workers/domains/${domain.id}`, 'DELETE');
  const scripts = await api(`${base}/workers/scripts`);
  if (scripts.some(value => value.id === name)) await mutate('remove-worker', script, 'DELETE');
  if (database) await mutate('remove-database', `${base}/d1/database/${database.uuid}`, 'DELETE');
} else {
  const commit = process.env.MAILSTACK_STAGING_COMMIT ?? (existsSync(`${state}/resources.json`) ? JSON.parse(readFileSync(`${state}/resources.json`)).commit : execFileSync('git', ['rev-parse', 'main'], { cwd: root, encoding: 'utf8' }).trim());
  execFileSync('git', ['merge-base', '--is-ancestor', commit, 'main'], { cwd: root });
  const source = `${state}/source/${commit}`;
  mkdirSync(source, { recursive: true, mode: 0o700 });
  execFileSync('tar', ['-xf', '-', '-C', source], { input: execFileSync('git', ['archive', commit, 'src', 'package.json', 'config/mailstack.example.json'], { cwd: root, maxBuffer: 16 * 1024 * 1024 }) });
  put('account-settings.json', await api(`${base}/workers/account-settings`));
  // No plan upgrades or subscription writes are performed by this script.
  if (!database) database = await mutate('create-database', `${base}/d1/database`, 'POST', { name });
  put('resources.json', { account, name, database: database.uuid, hostname, commit });
  const cfg = JSON.parse(readFileSync(`${source}/config/mailstack.example.json`));
  for (const brand of Object.values(cfg.brands)) { brand.captcha = 'altcha'; brand.autoReply = false; brand.allowedOrigins = [`https://${hostname}`]; }
  if (delivery === 'ses') {
    for (const brand of Object.values(cfg.brands)) {
      brand.from = 'no-reply@mailstack-test.techskills.academy';
      brand.to = ['success@simulator.amazonses.com'];
    }
    cfg.events = { ses: { topicArns: ['arn:aws:sns:eu-west-1:207570392857:mailstack-staging-events'], accountIds: ['207570392857'], allowSignatureV1: false } };
  }
  cfg.sender = { type: 'ses' }; cfg.legacyApiKey = { enabled: false };
  cfg.logging.defaults = { ...cfg.logging.defaults, level: 'masked', requireLog: true, contentDays: 1, metaDays: 7 };
  const pair = generateKeyPairSync('x25519'), kid = 'staging-content';
  const secrets = existsSync(`${state}/secrets.json`) ? JSON.parse(readFileSync(`${state}/secrets.json`)) : {
    SEND_TOKEN: randomBytes(32).toString('base64url'), HOOK_TOKEN: randomBytes(32).toString('base64url'),
    SELLF_STAGING_HMAC: randomBytes(32).toString('base64url'), ALTCHA_HMAC_KEY: randomBytes(32).toString('base64url'),
    CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid }] }),
    INDEX_KEYS: JSON.stringify([{ kid: 'staging-index', key: randomBytes(32).toString('base64url') }]),
  };
  for (const [key, id] of [['SEND_TOKEN', 'staging-send'], ['HOOK_TOKEN', 'staging-hook']]) {
    if (!secrets[key].startsWith(`msk_${id}_`)) secrets[key] = `msk_${id}_${secrets[key]}`;
  }
  if (!existsSync(`${state}/secrets.json`)) put('content-private.json', { keys: [{ ...pair.privateKey.export({ format: 'jwk' }), kid }] });
  put('secrets.json', secrets);
  cfg.clients = [
    { id: 'staging-send', tokenSha256: digest(secrets.SEND_TOKEN), scopes: ['send'], brands: ['acme'], templates: ['notice'], recipientOverride: delivery === 'ses' },
    { id: 'staging-hook', tokenSha256: digest(secrets.HOOK_TOKEN), scopes: ['hook:sellf'], brands: ['acme'], templates: ['payment', 'notice', 'welcome'], sellfSignatureSecretEnv: 'SELLF_STAGING_HMAC' },
  ];
  put('mailstack.json', cfg);
  const configJSON = JSON.stringify(cfg), sha = digest(configJSON);
  // The staging composition restricts every enabled provider call to the simulator.
  const fixture = existsSync(`${state}/fixture-jwks.json`) ? JSON.parse(readFileSync(`${state}/fixture-jwks.json`)) : { keys: [] };
  const limits = { day: Number(process.env.MAILSTACK_STAGING_SES_DAY ?? 50), hour: Number(process.env.MAILSTACK_STAGING_SES_HOUR ?? 10) };
  if (![limits.day,limits.hour].every(n=>Number.isSafeInteger(n)&&n>0)||limits.day>50||limits.hour>10) throw Error('Invalid staging allocation');
  const contents = `import {sendEmail} from './src/ses.ts';
import {createApp} from './src/index.ts';
import {budgetSender,budgetResponse} from ${JSON.stringify(resolve(root,'scripts/staging/ses-budget.ts'))};
const disabled=async()=>({ok:false,status:503,response:'staging_delivery_disabled'});
export default {async scheduled(...args){return createApp({sendEmail:disabled}).scheduled(...args);},async fetch(req,env,ctx){
const path=new URL(req.url).pathname;
if(req.method==='GET'&&path==='/_staging/jwks')return Response.json(${JSON.stringify(fixture)});
if(req.method==='GET'&&path==='/_staging/revoked')return Response.json({order_hashes:[]});
let reason;
const sender=${JSON.stringify(delivery)}==='ses'?budgetSender(async(sql,values=[])=>{const r=await env.DB.prepare(sql).bind(...values).all();if(!r.success)throw Error('budget storage');return r.results;},sendEmail,${JSON.stringify(limits)}):disabled;
const app=createApp({sendEmail:async(...args)=>{const r=await sender(...args);if(!r.ok&&r.response.startsWith('staging_'))reason=r.response;return r;}});
const r=await app.fetch(req,env,ctx);const h=new Headers(r.headers);h.set('X-Mailstack-Delivery',${JSON.stringify(delivery)});
if(${JSON.stringify(delivery)}==='disabled'&&r.status===502)return Response.json({success:false,message:'staging delivery disabled',code:'delivery_disabled'},{status:503,headers:h});
return budgetResponse(new Response(r.body,{status:r.status,headers:h}),reason);}};`;
  await build({ stdin: { contents, resolveDir: source, sourcefile: 'staging-entry.ts', loader: 'ts' }, outfile: `${state}/worker.mjs`, bundle: true, platform: 'browser', format: 'esm', nodePaths: [`${root}/node_modules`], conditions: ['workerd', 'worker', 'browser'], external: ['node:*'], plugins: [{ name: 'staging-config', setup(b) {
    b.onResolve({ filter: /\/bundled\.ts$/ }, () => ({ path: 'config', namespace: 'staging' }));
    b.onLoad({ filter: /.*/, namespace: 'staging' }, () => ({ contents: `export const CONFIG_JSON=${JSON.stringify(configJSON)}; export const BUILD_CONFIG_SHA=${JSON.stringify(sha)};` }));
    b.onResolve({ filter: /\/assets\/logo$/ }, () => ({ path: `${source}/src/assets/logo.example.ts` }));
  } }] });
  const { INITIAL_SCHEMA: migration } = await import(pathToFileURL(`${source}/src/core/store/migration.ts`).href);
  const rows = await api(`${base}/d1/database/${database.uuid}/query`, 'POST', { sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='messages'" });
  if (!rows[0].results.length) await mutate('migrate-database', `${base}/d1/database/${database.uuid}/query`, 'POST', { sql: migration });
  const vars = { BUILD_COMMIT: commit, BUILD_CONFIG_SHA: sha, SELLF_DEFAULT_BRAND: 'acme', SES_REGION: 'eu-west-1' };
  const providerSecrets = {};
  if (delivery === 'ses') {
    const item = process.env.SES_ACCESS_KEY_ID && process.env.SES_SECRET_ACCESS_KEY ? undefined : JSON.parse(execFileSync('bw', ['get', 'item', 'f72c4222-7be5-4adf-93ee-fae403e2d9f2'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    providerSecrets.SES_ACCESS_KEY_ID = process.env.SES_ACCESS_KEY_ID ?? item?.login?.username;
    providerSecrets.SES_SECRET_ACCESS_KEY = process.env.SES_SECRET_ACCESS_KEY ?? item?.login?.password;
    if (!providerSecrets.SES_ACCESS_KEY_ID || !providerSecrets.SES_SECRET_ACCESS_KEY) throw new Error('Missing staging SES credentials');
    vars.SES_CONFIGURATION_SET = 'mailstack-staging';
  }
  const metadata = { main_module: 'worker.mjs', compatibility_date: '2026-10-26', compatibility_flags: ['nodejs_compat'], bindings: [
    { name: 'DB', type: 'd1', id: database.uuid },
    ...Object.entries(vars).map(([name, text]) => ({ name, text, type: 'plain_text' })),
    ...Object.entries({ ...secrets, ...providerSecrets }).filter(([key]) => !['SEND_TOKEN', 'HOOK_TOKEN'].includes(key)).map(([name, text]) => ({ name, text, type: 'secret_text' })),
  ], observability: { enabled: false } };
  const form = new FormData(); form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.set('worker.mjs', new Blob([readFileSync(`${state}/worker.mjs`)], { type: 'application/javascript+module' }), 'worker.mjs');
  await mutate('upload-worker', script, 'PUT', form);
  await mutate('set-cron', `${script}/schedules`, 'PUT', [{ cron: '17 * * * *' }]);
  const zones = await api('/zones?name=techskills.academy');
  const zone = zones.find(value => value.account.id === account);
  if (!zone) throw new Error('Zone unavailable');
  if (!domain) await mutate('attach-domain', `${base}/workers/domains`, 'PUT', { hostname, service: name, environment: 'production', zone_id: zone.id });
  console.log(`Staging ready: https://${hostname}; delivery ${delivery}; keys stored outside source`);
}
