import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, generateKeyPairSync, createHash } from 'node:crypto';
import { build } from 'esbuild';
import { changeHmac, verifyHmac } from './hmac.mjs';
import { stagingOptions } from './accounts.mjs';
import { operatorEnvironment, required } from './operator.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const env = operatorEnvironment();
const options = stagingOptions(env);
const state = resolve(options.state), { account, productionAccount, routing } = options;
const workersDev = routing === 'workers-dev';
const delivery = env.MAILSTACK_STAGING_DELIVERY ?? 'disabled';
const sesConfigurationSet = env.MAILSTACK_STAGING_SES_CONFIGURATION_SET;
const sesRegion = env.MAILSTACK_STAGING_SES_REGION;
const sesAccount = env.MAILSTACK_STAGING_AWS_ACCOUNT_ID;
const sesFrom = env.MAILSTACK_STAGING_FROM;
if (delivery === 'ses') for (const key of ['MAILSTACK_STAGING_SES_CONFIGURATION_SET', 'MAILSTACK_STAGING_SES_REGION', 'MAILSTACK_STAGING_AWS_ACCOUNT_ID', 'MAILSTACK_STAGING_FROM']) required(env, key);
const sesTopic = `arn:aws:sns:${sesRegion}:${sesAccount}:${sesConfigurationSet}-events`;
const name = 'mailstack-staging';
let hostname = workersDev ? undefined : required(env, 'MAILSTACK_STAGING_HOST');
// A Worker cannot fetch its own custom domain (522), so Pro reads the fixture license endpoints from a second Worker.
const licenseName = 'mailstack-staging-license';
let licenseHost = workersDev ? undefined : required(env, 'MAILSTACK_STAGING_LICENSE_HOST');
// With Pro the panel reads /internal/v2/* only on this host, which sits behind Cloudflare Access.
const internalHost = workersDev ? 'mailstack-staging.internal' : required(env, 'MAILSTACK_STAGING_INTERNAL_HOST');
const command = process.argv[2] ?? 'status';
const productionHealth = required(env, 'MAILSTACK_PRODUCTION_HEALTH_URL');
if (!workersDev && command === 'deploy') required(env, 'MAILSTACK_STAGING_ZONE');
const savedSecrets = command === 'deploy' && existsSync(`${state}/secrets.json`) ? JSON.parse(readFileSync(`${state}/secrets.json`)) : {};
if (command === 'deploy' && (savedSecrets.TOMBSTONE_REGISTRY_ID || env.MAILSTACK_STAGING_B2_KEY_ID && env.MAILSTACK_STAGING_B2_APP_KEY && env.MAILSTACK_STAGING_AGE_RECIPIENT)) {
  required(env, 'MAILSTACK_STAGING_B2_ENDPOINT'); required(env, 'MAILSTACK_STAGING_B2_BUCKET');
}
// Optional Mailstack Pro checkout (clean tree); its commit is extracted like the core one.
const pro = env.MAILSTACK_STAGING_PRO, branch = env.MAILSTACK_STAGING_BRANCH ?? 'main';
// MAILSTACK_STAGING_EGRESS_URL=https://<egress host> (with Pro): the egress service behind the staging Tunnel, a key-guarded
// probe for the SSRF acceptance (A 3.6) and a webhook endpoint at the receiver (M8). The Access service token comes from
// MAILSTACK_STAGING_EGRESS_ACCESS_ID/_SECRET on the first deploy; EGRESS_KEYS is generated into the state for the service.
const egress = env.MAILSTACK_STAGING_EGRESS_URL?.trim();
if (egress && !(pro && /^https:\/\/[a-z0-9.-]+$/.test(egress))) throw new Error('MAILSTACK_STAGING_EGRESS_URL needs MAILSTACK_STAGING_PRO and an https origin');
if (!['disabled', 'ses'].includes(delivery)) throw new Error('Delivery must be disabled or ses');
// The internal host needs the Access team host and the AUD tag of its Access application.
const access = { ACCESS_TEAM_DOMAIN: env.MAILSTACK_ACCESS_TEAM_DOMAIN?.trim(), ACCESS_AUD: env.MAILSTACK_ACCESS_AUD?.trim() };
if (command === 'deploy' && pro && !workersDev && !(access.ACCESS_TEAM_DOMAIN && access.ACCESS_AUD)) throw new Error('Set MAILSTACK_ACCESS_TEAM_DOMAIN and MAILSTACK_ACCESS_AUD for the internal host');
if (!account || !['deploy', 'status', 'destroy', 'hmac-swap', 'hmac-restore'].includes(command)) throw new Error('Set CLOUDFLARE_ACCOUNT_ID; use deploy|status|destroy|hmac-swap|hmac-restore');
if (state.startsWith(root + '/')) throw new Error('State must be outside the source directory');
process.umask(0o077); mkdirSync(state, { recursive: true, mode: 0o700 });
const put = (file, value) => {
  const path = `${state}/${file}`, data = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (file !== 'secrets.json') { writeFileSync(path, data, { mode: 0o600 }); return path; }
  const next = `${path}.${randomBytes(16).toString('hex')}.tmp`;
  try {
    writeFileSync(next, data, { flag: 'wx', mode: 0o600, flush: true });
    renameSync(next, path);
  } finally { rmSync(next, { force: true }); }
};
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const password = item => execFileSync('bw', ['get', 'password', item], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const token = env.CLOUDFLARE_API_TOKEN ?? password(options.tokenItem);
const productionToken = env.MAILSTACK_PRODUCTION_API_TOKEN ?? password(required(env, 'MAILSTACK_PRODUCTION_TOKEN_ITEM'));
async function api(path, method = 'GET', body, credential = token) {
  const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
    method, headers: { Authorization: `Bearer ${credential}`, ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000),
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(`Cloudflare ${method} ${path}: ${response.status} ${JSON.stringify(data.errors)}`);
  return data.result;
}
const base = `/accounts/${account}`, script = `${base}/workers/scripts/${name}`;
async function fingerprint() {
  const deployments = await api(`/accounts/${productionAccount}/workers/scripts/mailstack/deployments`, 'GET', undefined, productionToken);
  const response = await fetch(productionHealth, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Error('Production health unavailable');
  return digest(canonical({ deployments, health: await response.text() }));
}
let sequence = 0;
const mutate = (label, path, method, body) => guarded(label, () => api(path, method, body));
async function guarded(label, run) {
  const before = await fingerprint(); let result;
  try { result = await run(); }
  finally {
    const after = await fingerprint();
    put(`mutation-${Date.now()}-${++sequence}.json`, { label, before, after, identical: before === after });
    if (before !== after) throw new Error('Production fingerprint changed; stop');
  }
  console.log(`${label}: production IDENTICAL`); return result;
}
const databases = await api(`${base}/d1/database`);
let database = databases.find(value => value.name === name);
if (workersDev) {
  const { subdomain } = await api(`${base}/workers/subdomain`);
  if (!subdomain || !/^[a-z0-9-]+$/.test(subdomain)) throw Error('Configure the account workers.dev subdomain first');
  hostname = `${name}.${subdomain}.workers.dev`;
  licenseHost = `${licenseName}.${subdomain}.workers.dev`;
}
// Never reuse another account's database, keys or SES budget implicitly.
if (existsSync(`${state}/resources.json`)) {
  const record = JSON.parse(readFileSync(`${state}/resources.json`));
  if (record.account !== account || record.name !== name || record.hostname !== hostname || (database || command !== 'destroy') && record.database !== database?.uuid) throw Error('Staging resource identity differs');
}
const domains = workersDev ? [] : await api(`${base}/workers/domains`);
const domain = domains.find(value => value.hostname === hostname), licenseDomain = domains.find(value => value.hostname === licenseHost), internalDomain = domains.find(value => value.hostname === internalHost);
if (internalDomain && internalDomain.service !== name) throw new Error('Internal hostname is already assigned to another service');
if (licenseDomain && licenseDomain.service !== licenseName) throw new Error('License hostname is already assigned to another service');
if (domain && domain.service !== name) throw new Error('Staging hostname is already assigned to another service');
if (command.startsWith('hmac-')) {
  const record = JSON.parse(readFileSync(`${state}/resources.json`));
  if (record.account !== account || record.name !== name || record.database !== database?.uuid || !workersDev && domain?.service !== name) throw Error('Staging resource identity differs');
  const secrets = JSON.parse(readFileSync(`${state}/secrets.json`));
  await changeHmac(command, command === 'hmac-swap' ? readFileSync(0, 'utf8').trim() : undefined, {
    dir: state, identity: `${account}:${name}:${database.uuid}`, fingerprint,
    read: async () => secrets.SELLF_STAGING_HMAC,
    apply: async value => {
      secrets.SELLF_STAGING_HMAC = value;
      put('secrets.json', secrets);
      await mutate('hmac-secret', `${script}/secrets`, 'PUT', { name: 'SELLF_STAGING_HMAC', text: value, type: 'secret_text' });
    },
    verify: (active, inactive) => verifyHmac(`https://${hostname}`, secrets.API_KEY, active, inactive),
  });
  console.log(`${command}: verified; production IDENTICAL`);
} else if (command === 'status') {
  console.log(JSON.stringify({ account, productionAccount, routing, name, hostname, database: database?.uuid, domain: domain?.service, production: await fingerprint() }, null, 2));
} else if (command === 'destroy') {
  const record = JSON.parse(readFileSync(`${state}/resources.json`));
  if (record.account !== account || record.name !== name || database && record.database !== database.uuid) throw new Error('Resource identity differs from local record');
  if (domain) await mutate('remove-domain', `${base}/workers/domains/${domain.id}`, 'DELETE');
  if (internalDomain) await mutate('remove-internal-domain', `${base}/workers/domains/${internalDomain.id}`, 'DELETE');
  if (licenseDomain) await mutate('remove-license-domain', `${base}/workers/domains/${licenseDomain.id}`, 'DELETE');
  const scripts = await api(`${base}/workers/scripts`);
  if (scripts.some(value => value.id === licenseName)) await mutate('remove-license-worker', `${base}/workers/scripts/${licenseName}`, 'DELETE');
  if (scripts.some(value => value.id === name)) await mutate('remove-worker', script, 'DELETE');
  if (database) await mutate('remove-database', `${base}/d1/database/${database.uuid}`, 'DELETE');
} else {
  const commit = env.MAILSTACK_STAGING_COMMIT ?? (existsSync(`${state}/resources.json`) ? JSON.parse(readFileSync(`${state}/resources.json`)).commit : execFileSync('git', ['rev-parse', branch], { cwd: root, encoding: 'utf8' }).trim());
  execFileSync('git', ['merge-base', '--is-ancestor', commit, branch], { cwd: root });
  const proCommit = pro && execFileSync('git', ['rev-parse', 'HEAD'], { cwd: pro, encoding: 'utf8' }).trim();
  if (pro && execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: pro, encoding: 'utf8' })) throw new Error('Pro checkout must be clean');
  const proSource = pro && `${state}/source-pro/${proCommit}`;
  if (pro) { mkdirSync(proSource, { recursive: true, mode: 0o700 }); execFileSync('tar', ['-xf', '-', '-C', proSource], { input: execFileSync('git', ['archive', proCommit, 'src'], { cwd: pro, maxBuffer: 16 * 1024 * 1024 }) }); }
  const source = `${state}/source/${commit}`;
  mkdirSync(source, { recursive: true, mode: 0o700 });
  execFileSync('tar', ['-xf', '-', '-C', source], { input: execFileSync('git', ['archive', commit, 'src', 'package.json', 'scripts/worker-schema.ts', 'config/mailstack.example.json', ':(glob)docs/sources/*.json'], { cwd: root, maxBuffer: 16 * 1024 * 1024 }) });
  put('account-settings.json', await api(`${base}/workers/account-settings`));
  // No plan upgrades or subscription writes are performed by this script.
  if (!database) database = await mutate('create-database', `${base}/d1/database`, 'POST', { name });
  put('resources.json', { account, name, database: database.uuid, hostname, licenseHost, routing, commit });
  const cfg = JSON.parse(readFileSync(env.MAILSTACK_STAGING_CONFIG ?? `${source}/config/mailstack.example.json`));
  for (const brand of Object.values(cfg.brands)) { brand.captcha = 'altcha'; brand.autoReply = false; brand.allowedOrigins = [`https://${hostname}`]; }
  if (delivery === 'ses') {
    for (const brand of Object.values(cfg.brands)) {
      brand.from = sesFrom;
      brand.to = ['success@simulator.amazonses.com'];
    }
    cfg.events = { ses: { topicArns: [sesTopic], accountIds: [sesAccount], allowSignatureV1: false } };
  }
  cfg.sender = { type: 'ses' }; delete cfg.clients;
  // The full key carries the Sellf hook signature; Pro adds scoped clients with tokens in secrets.json.
  cfg.legacyApiKey = { enabled: true, env: 'API_KEY', signatureSecretEnv: 'SELLF_STAGING_HMAC' };
  cfg.logging.defaults = { ...cfg.logging.defaults, level: 'masked', requireLog: true, contentDays: 1, metaDays: 7 };
  const pair = generateKeyPairSync('x25519'), kid = 'staging-content';
  const secrets = existsSync(`${state}/secrets.json`) ? JSON.parse(readFileSync(`${state}/secrets.json`)) : {
    SELLF_STAGING_HMAC: randomBytes(32).toString('base64url'), ALTCHA_HMAC_KEY: randomBytes(32).toString('base64url'),
    CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid }] }),
    INDEX_KEYS: JSON.stringify([{ kid: 'staging-index', key: randomBytes(32).toString('base64url') }]),
  };
  secrets.API_KEY ??= randomBytes(32).toString('base64url');
  // Transit keyring: the Worker opens panel envelopes with it; capabilities publishes the public half.
  secrets.TRANSIT_KEYS ??= JSON.stringify({ keys: [{ ...generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' }), kid: 'staging-transit' }] });
  delete secrets.SEND_TOKEN; delete secrets.HOOK_TOKEN;
  if (!existsSync(`${state}/secrets.json`)) put('content-private.json', { keys: [{ ...pair.privateKey.export({ format: 'jwk' }), kid }] });
  secrets.STAGING_RECEIVER_TOKEN ??= randomBytes(32).toString('base64url');
  secrets.STAGING_RECEIVER_KEY ??= randomBytes(32).toString('base64url');
  // Erasure register (R5): a B2 key limited to the staging prefix and the owner's age recipient, given once; erasure stays off without them.
  const b2 = { B2_KEY_ID: env.MAILSTACK_STAGING_B2_KEY_ID, B2_APP_KEY: env.MAILSTACK_STAGING_B2_APP_KEY, BACKUP_AGE_RECIPIENT: env.MAILSTACK_STAGING_AGE_RECIPIENT };
  const register = Object.values(b2).every(Boolean);
  if (register) Object.assign(secrets, b2, { TOMBSTONE_REGISTRY_ID: secrets.TOMBSTONE_REGISTRY_ID ?? randomBytes(16).toString('hex') });
  const registerVars = secrets.TOMBSTONE_REGISTRY_ID ? { B2_ENDPOINT: required(env, 'MAILSTACK_STAGING_B2_ENDPOINT'), B2_BUCKET: required(env, 'MAILSTACK_STAGING_B2_BUCKET'), TOMBSTONE_PREFIX: workersDev ? `staging-tombstones/${account}/` : 'staging-tombstones/' } : {};
  if (pro) {
    if (env.MAILSTACK_STAGING_LICENSE) secrets.MAILSTACK_LICENSE = env.MAILSTACK_STAGING_LICENSE;
    if (!secrets.MAILSTACK_LICENSE) throw new Error('Set MAILSTACK_STAGING_LICENSE for the first Pro deploy');
    secrets.STAGING_SEND_TOKEN ??= `msk_st-send_${randomBytes(32).toString('base64url')}`;
    secrets.STAGING_HOOK_TOKEN ??= `msk_st-hook_${randomBytes(32).toString('base64url')}`;
    secrets.STAGING_PANEL_TOKEN ??= `msk_st-panel_${randomBytes(32).toString('base64url')}`;
    secrets.STAGING_PANEL_WORKER_TOKEN ??= `msk_st-panel-worker_${randomBytes(32).toString('base64url')}`;
    secrets.STAGING_SOURCE_TOKEN ??= `msk_st-source_${randomBytes(32).toString('base64url')}`;
    secrets.STAGING_RESEND_SECRET ??= randomBytes(32).toString('base64url');
    secrets.PANEL_ASSERTION_KEYS ??= JSON.stringify([{ kid: 'st-panel-1', key: secrets.PANEL_ASSERTION_KEY ?? randomBytes(32).toString('base64url') }]);
    delete secrets.PANEL_ASSERTION_KEY;
    cfg.extensions = [{ module: 'mailstack-pro', options: { product: 'mailstack-pro-test', host: hostname, seller: 'staging-fixture',
      jwksUrl: `https://${licenseHost}/_staging/jwks`, revocationUrl: `https://${licenseHost}/_staging/revoked`,
      // The panel's AWS page sends simulator scenarios in process (SES delivery only).
      ...delivery === 'ses' ? { aws: { brands: [{ id: 'acme', test: true }] } } : {} } }];
    cfg.clients = [
      { id: 'st-send', tokenSha256: digest(secrets.STAGING_SEND_TOKEN), scopes: ['send'], brands: ['acme'], templates: ['notice'] },
      { id: 'st-hook', tokenSha256: digest(secrets.STAGING_HOOK_TOKEN), scopes: ['hook:sellf'], brands: ['acme'], templates: ['payment', 'refund', 'notice', 'welcome'], signatureSecretEnv: 'SELLF_STAGING_HMAC' },
      { id: 'st-panel', tokenSha256: digest(secrets.STAGING_PANEL_TOKEN), scopes: ['panel', 'webhooks:write'], brands: '*', templates: '*' },
      { id: 'st-panel-worker', tokenSha256: digest(secrets.STAGING_PANEL_WORKER_TOKEN), scopes: ['panel', 'webhooks:write'], brands: '*', templates: '*' },
      { id: 'st-source', tokenSha256: digest(secrets.STAGING_SOURCE_TOKEN), scopes: ['send'], brands: ['acme'], templates: ['license'], resendCallback: { url: `https://${hostname}/_staging/receiver/${secrets.STAGING_RECEIVER_TOKEN}/resend`, secretEnv: 'STAGING_RESEND_SECRET' } },
    ];
    // Panel resend (M9): replay for acme notice/payment; license (secret fields) only from its source through the receiver.
    cfg.logging.brands = { acme: { templates: { notice: { resend: 'replay' }, payment: { resend: 'replay' }, license: { resend: 'source' } } } };
  }
  if (egress) {
    secrets.EGRESS_KEYS ??= JSON.stringify([{ kid: 'st-egress-1', key: randomBytes(32).toString('base64url') }]);
    secrets.EGRESS_ACCESS_CLIENT_ID = env.MAILSTACK_STAGING_EGRESS_ACCESS_ID ?? secrets.EGRESS_ACCESS_CLIENT_ID;
    secrets.EGRESS_ACCESS_CLIENT_SECRET = env.MAILSTACK_STAGING_EGRESS_ACCESS_SECRET ?? secrets.EGRESS_ACCESS_CLIENT_SECRET;
    if (!secrets.EGRESS_ACCESS_CLIENT_ID || !secrets.EGRESS_ACCESS_CLIENT_SECRET) throw new Error('Set MAILSTACK_STAGING_EGRESS_ACCESS_ID and _SECRET for the first egress deploy');
    secrets.PRO_WEBHOOK_KEYS ??= JSON.stringify([{ kid: 'st-webhook-1', key: randomBytes(32).toString('base64url') }]);
    secrets.STAGING_WEBHOOK_SECRET ??= randomBytes(32).toString('base64url');
    cfg.extensions[0].options.webhooks = { endpoints: [{ id: 'st-receiver', url: `https://${hostname}/_staging/receiver/${secrets.STAGING_RECEIVER_TOKEN}/m8`, secretEnv: 'STAGING_WEBHOOK_SECRET', events: ['message.sent'], brands: ['acme'] }] };
  }
  put('secrets.json', secrets);
  put('mailstack.json', cfg);
  const configJSON = JSON.stringify(cfg), sha = digest(configJSON);
  await build({ stdin: { contents: `import {loadConfig} from "./src/core/config/load.ts"; import {templatePlans} from "./src/templates/config.ts";
    export const VALIDATED_CONFIG=loadConfig(${JSON.stringify(configJSON)}); export const TEMPLATE_PLANS=templatePlans(VALIDATED_CONFIG);`, resolveDir: source, loader: 'ts' },
    outfile: `${state}/config.mjs`, bundle: true, platform: 'node', format: 'esm', nodePaths: [`${root}/node_modules`] });
  const { VALIDATED_CONFIG, TEMPLATE_PLANS } = await import(pathToFileURL(`${state}/config.mjs`).href);
  // The staging composition restricts every enabled provider call to the simulator.
  const fixture = existsSync(`${state}/fixture-jwks.json`) ? JSON.parse(readFileSync(`${state}/fixture-jwks.json`)) : { keys: [] };
  const limits = { day: Number(env.MAILSTACK_STAGING_SES_DAY ?? 50), hour: Number(env.MAILSTACK_STAGING_SES_HOUR ?? 10) };
  if (![limits.day,limits.hour].every(n=>Number.isSafeInteger(n)&&n>0)||limits.day>50||limits.hour>10) throw Error('Invalid staging allocation');
  const contents = `import {AsyncLocalStorage} from 'node:async_hooks';
import {WorkerEntrypoint} from 'cloudflare:workers';
import {sendEmail} from './src/ses.ts';
import {createApp} from './src/index.ts';
import {receiver,receiverCleanup} from ${JSON.stringify(resolve(root,'scripts/staging/receiver.ts'))};
const query=env=>async(sql,values=[])=>{const r=await env.DB.prepare(sql).bind(...values).all();if(!r.success)throw Error('staging storage');return r.results;};
import {budgetSender,budgetResponse} from ${JSON.stringify(resolve(root,'scripts/staging/ses-budget.ts'))};
${egress ? `import {workerEgress} from ${JSON.stringify(`${proSource}/src/egress/worker.ts`)};
const probe=async(req,env)=>{const o=await req.json(),t=Date.now(),e=workerEgress(env),ready=await e.ready(),readyMs=Date.now()-t,s=Date.now();
try{const result=await e.post({attemptId:crypto.randomUUID(),url:o.url,headers:{'content-type':'application/json'},body:'{}',notAfter:Date.now()+(o.ms??10000)});return Response.json({ready,readyMs,postMs:Date.now()-s,result});}catch(err){return Response.json({ready,readyMs,postMs:Date.now()-s,error:err.message});}};` : 'const probe=null;'}
const disabled=async()=>({ok:false,status:503,response:'staging_delivery_disabled'});
// Match the production module-level app; only the outcome belongs to a request.
const outcome=new AsyncLocalStorage();
const app=createApp({sendEmail:async(env,params)=>{
const state=outcome.getStore();
const sender=!state?.scheduled&&${JSON.stringify(delivery)}==='ses'?budgetSender(query(env),sendEmail,${JSON.stringify(sesFrom)},${JSON.stringify(limits)}):disabled;
const r=await sender(env,params);if(state&&!r.ok&&typeof r.response==='string'&&r.response.startsWith('staging_'))state.reason=r.response;return r;}});
async function serve(req,env,ctx,bound){
const path=new URL(req.url).pathname;
if(!bound){const captured=await receiver(query(env),{token:env.STAGING_RECEIVER_TOKEN,key:env.STAGING_RECEIVER_KEY})(req);if(captured)return captured;
if(probe&&path==='/_staging/egress'&&req.method==='POST'&&req.headers.get('authorization')==='Bearer '+env.STAGING_RECEIVER_KEY)return probe(req,env);
if(probe&&path==='/_staging/redirect')return new Response(null,{status:302,headers:{location:'https://10.0.0.1/'}});
if(probe&&path==='/_staging/slow')return new Promise(done=>setTimeout(()=>done(new Response('late')),15000));
if(probe&&path==='/_staging/stream')return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(Number(new URL(req.url).searchParams.get('n'))));c.close();}}));
if(req.method==='GET'&&path==='/_staging/jwks')return Response.json(${JSON.stringify(fixture)});
if(req.method==='GET'&&path==='/_staging/revoked')return Response.json({order_hashes:[]});}
const r=await (bound?app.internal(req,env,ctx):app.fetch(req,env,ctx));const h=new Headers(r.headers);h.set('X-Mailstack-Delivery',${JSON.stringify(delivery)});
if(${JSON.stringify(delivery)}==='disabled'&&r.status===502)return Response.json({success:false,message:'staging delivery disabled',code:'delivery_disabled'},{status:503,headers:h});
return budgetResponse(new Response(r.body,{status:r.status,headers:h}),outcome.getStore()?.reason);}
export default {scheduled:(event,env,ctx)=>outcome.run({scheduled:true},()=>{ctx.waitUntil(receiverCleanup(query(env)));return app.scheduled(event,env,ctx);}),fetch:(req,env,ctx)=>outcome.run({},()=>serve(req,env,ctx,false))};
// Profile (a): the staging panel Worker's service binding; only /internal/* (app.internal), same staging sender.
export class Internal extends WorkerEntrypoint{fetch(req){return outcome.run({},()=>serve(req,this.env,this.ctx,true));}}`;
  await build({ stdin: { contents, resolveDir: source, sourcefile: 'staging-entry.ts', loader: 'ts' }, outfile: `${state}/worker.mjs`, bundle: true, platform: 'browser', format: 'esm', nodePaths: [`${root}/node_modules`, ...pro ? [`${pro}/node_modules`] : []], alias: { mailstack: source, zod: `${root}/node_modules/zod` }, conditions: ['workerd', 'worker', 'browser'], external: ['node:*', 'cloudflare:*'], plugins: [{ name: 'staging-config', setup(b) {
    b.onResolve({ filter: /\/bundled\.ts$/ }, () => ({ path: 'config', namespace: 'staging' }));
    b.onLoad({ filter: /.*/, namespace: 'staging' }, () => ({ contents: `export const CONFIG_JSON=${JSON.stringify(configJSON)}; export const BUILD_CONFIG_SHA=${JSON.stringify(sha)}; export const VALIDATED_CONFIG=${JSON.stringify(VALIDATED_CONFIG)}; export const TEMPLATE_PLANS=${JSON.stringify(TEMPLATE_PLANS)};` }));
    b.onResolve({ filter: /\/assets\/logo$/ }, () => ({ path: `${source}/src/assets/logo.example.ts` }));
    b.onResolve({ filter: /\/pro\.generated$/ }, () => ({ path: 'pro', namespace: 'staging-pro' }));
    b.onLoad({ filter: /.*/, namespace: 'staging-pro' }, () => ({ resolveDir: source, loader: 'ts', contents: pro ? `import * as pro from ${JSON.stringify(`${proSource}/src/worker.ts`)}; export { workerKeys as proKeys } from ${JSON.stringify(`${proSource}/src/worker.ts`)}; export const proExtension = pro.workerExtension;` : 'export const proKeys = undefined; export const proExtension = undefined;' }));
  } }] });
  // Deployment and Node use the same upgrade path, including existing tables and extension columns.
  await build({ stdin: { contents: `export {migrateWorker,remoteStore} from ${JSON.stringify(`${source}/scripts/worker-schema.ts`)};${pro ? `export * as proSchema from ${JSON.stringify(`${proSource}/src/worker.ts`)};` : ''}`, resolveDir: source, loader: 'ts' },
    outfile: `${state}/schema.mjs`, bundle: true, platform: 'node', format: 'esm', nodePaths: [`${root}/node_modules`, ...pro ? [`${pro}/node_modules`] : []], alias: { mailstack: source }, external: ['node:*', 'cloudflare:*'] });
  const { migrateWorker, remoteStore, proSchema: proWorker } = await import(pathToFileURL(`${state}/schema.mjs`).href);
  const store = remoteStore(sql => mutate('migrate-schema', `${base}/d1/database/${database.uuid}/query`, 'POST', { sql }));
  try { await migrateWorker(store, proWorker || undefined, cfg.extensions?.[0]?.options); }
  finally { await store.db.destroy(); }
  if (register) { await (await import(pathToFileURL(`${root}/src/core/offsite.ts`).href)).initTombstoneRegistry({ ...secrets, ...registerVars }); console.log('Erasure register ready'); }
  const vars = { ...registerVars, ...pro ? { BUILD_PRO_COMMIT: proCommit, ...!workersDev ? { INTERNAL_HOST: internalHost, ...access } : {}, PANEL_AUDIENCE: internalHost } : {}, ...egress ? { EGRESS_URL: egress } : {}, BUILD_COMMIT: commit, BUILD_CONFIG_SHA: sha, ...sesRegion ? { SES_REGION: sesRegion } : {} };
  const providerSecrets = {};
  if (delivery === 'ses') {
    if (workersDev && !(env.SES_ACCESS_KEY_ID && env.SES_SECRET_ACCESS_KEY)) throw Error('Supply isolated staging SES credentials');
    const item = env.SES_ACCESS_KEY_ID && env.SES_SECRET_ACCESS_KEY ? undefined : JSON.parse(execFileSync('bw', ['get', 'item', required(env, 'MAILSTACK_STAGING_SES_TOKEN_ITEM')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    providerSecrets.SES_ACCESS_KEY_ID = env.SES_ACCESS_KEY_ID ?? item?.login?.username;
    providerSecrets.SES_SECRET_ACCESS_KEY = env.SES_SECRET_ACCESS_KEY ?? item?.login?.password;
    if (!providerSecrets.SES_ACCESS_KEY_ID || !providerSecrets.SES_SECRET_ACCESS_KEY) throw new Error('Missing staging SES credentials');
    vars.SES_CONFIGURATION_SET = sesConfigurationSet;
  }
  const metadata = { main_module: 'worker.mjs', compatibility_date: '2026-10-26', compatibility_flags: ['nodejs_compat', ...workersDev ? ['global_fetch_strictly_public'] : []], bindings: [
    { name: 'DB', type: 'd1', id: database.uuid },
    ...Object.entries(vars).map(([name, text]) => ({ name, text, type: 'plain_text' })),
    ...Object.entries({ ...secrets, ...providerSecrets }).map(([name, text]) => ({ name, text, type: 'secret_text' })),
  ], observability: { enabled: false } };
  const form = new FormData(); form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.set('worker.mjs', new Blob([readFileSync(`${state}/worker.mjs`)], { type: 'application/javascript+module' }), 'worker.mjs');
  await mutate('upload-worker', script, 'PUT', form);
  await mutate('set-cron', `${script}/schedules`, 'PUT', [{ cron: '* * * * *' }]);
  await mutate(workersDev ? 'enable-workers-dev' : 'disable-workers-dev', `${script}/subdomain`, 'POST', { enabled: workersDev, previews_enabled: false });
  const zones = workersDev ? [] : await api('/zones?name=' + encodeURIComponent(required(env, 'MAILSTACK_STAGING_ZONE')));
  const zone = zones.find(value => value.account.id === account);
  if (!workersDev && !zone) throw new Error('Zone unavailable');
  if (!workersDev && !domain) await mutate('attach-domain', `${base}/workers/domains`, 'PUT', { hostname, service: name, environment: 'production', zone_id: zone.id });
  if (pro) {
    const fixtureForm = new FormData();
    fixtureForm.set('metadata', new Blob([JSON.stringify({ main_module: 'license.mjs', compatibility_date: '2026-10-26', bindings: [], observability: { enabled: false } })], { type: 'application/json' }));
    fixtureForm.set('license.mjs', new Blob([`export default {fetch(req){const p=new URL(req.url).pathname;if(req.method==='GET'&&p==='/_staging/jwks')return Response.json(${JSON.stringify(fixture)});if(req.method==='GET'&&p==='/_staging/revoked')return Response.json({order_hashes:[]});return new Response(null,{status:404});}};`], { type: 'application/javascript+module' }), 'license.mjs');
    await mutate('upload-license-worker', `${base}/workers/scripts/${licenseName}`, 'PUT', fixtureForm);
    await mutate('license-workers-dev', `${base}/workers/scripts/${licenseName}/subdomain`, 'POST', { enabled: workersDev, previews_enabled: false });
    if (!workersDev && !internalDomain) await mutate('attach-internal-domain', `${base}/workers/domains`, 'PUT', { hostname: internalHost, service: name, environment: 'production', zone_id: zone.id });
    if (!workersDev && !licenseDomain) await mutate('attach-license-domain', `${base}/workers/domains`, 'PUT', { hostname: licenseHost, service: licenseName, environment: 'production', zone_id: zone.id });
  }
  console.log(`Staging ready: https://${hostname}; delivery ${delivery}; keys stored outside source`);
}
