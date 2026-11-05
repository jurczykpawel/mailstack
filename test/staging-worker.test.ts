import { runInNewContext } from 'node:vm';
import example from '../config/mailstack.example.json';
import { parseConfig } from '../src/core/config/schema';
import { resolvePolicy } from '../src/core/logging/policy';
import { projectArchive } from '../src/core/logging/projection';
import { getTemplate } from '../src/templates';
import { parseTransitKeys } from '../src/core/keyring';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { panelEnv } from './fixtures/panel';
const dirs: string[] = [];
// mutation-<ms>-<sequence>.json in write order (a lexical sort puts -10 before -9).
const mutations = (dir: string) => readdirSync(dir).filter(value => value.startsWith('mutation-')).sort((a, b) => Number(a.split(/[-.]/)[2]) - Number(b.split(/[-.]/)[2]));
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function run(command: string, change = false, ses = false, tables = '', extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mailstack-staging-')); dirs.push(dir);
  const preload = join(dir, 'mock.mjs');
  writeFileSync(preload, `import Database from ${JSON.stringify(new URL('../node_modules/better-sqlite3/lib/index.js', import.meta.url).pathname)};
const db=new Database(':memory:');
// A real SQL store keeps the deployment test sensitive to missing columns and indexes.
let writes=0;
const response=result=>Response.json({success:true,result});
globalThis.fetch=async(url,options={})=>{
if(url instanceof Request){(await import('node:fs')).appendFileSync(${JSON.stringify(join(dir, 'b2.log'))},url.method+' '+new URL(url.url).pathname+'\\n');return new Response('<ListBucketResult></ListBucketResult>');}
const path=new URL(url).pathname;
if(path.endsWith('/query'))(await import('node:fs')).appendFileSync(${JSON.stringify(join(dir, 'queries.jsonl'))},JSON.stringify(JSON.parse(options.body))+'\\n');
if(path.endsWith('/mailstack/deployments'))return response({id:${change ? "writes ? 'changed' : 'initial'" : "'initial'"}});
if(path.endsWith('/d1/database')&&(!options.method||options.method==='GET'))return response([]);
if(path.endsWith('/workers/domains')&&(!options.method||options.method==='GET'))return response([]);
if(path.endsWith('/workers/scripts')&&(!options.method||options.method==='GET'))return response([]);
if(path.endsWith('/account-settings'))return response({default_usage_model:'standard'});
if(path==='/client/v4/zones')return response([{id:'zone',account:{id:'test-account'}}]);
if(path.endsWith('/query')){
 const statements=JSON.parse(options.body).sql.split(';').map(s=>s.trim()).filter(Boolean);
 return response(db.transaction(()=>statements.map(sql=>{const s=db.prepare(sql);return {success:true,results:s.reader?s.all():[],meta:{changes:s.reader?0:s.run().changes}};}))());
}
if(path.endsWith('/workers/scripts/mailstack-staging')&&options.method==='PUT'){
 const m=JSON.parse(await options.body.get('metadata').text());
 const safe=m.bindings.map(b=>({name:b.name,type:b.type,...(b.type==='plain_text'?{text:b.text}:{})}));
 const fs=await import('node:fs');fs.writeFileSync(${JSON.stringify(join(dir, 'uploaded-bindings.json'))},JSON.stringify(safe));
}
writes++;return response({uuid:'staging-database'});
};`);
  if (command === 'destroy') writeFileSync(join(dir, 'resources.json'), JSON.stringify({ account: 'test-account', name: 'mailstack-staging', database: 'staging-database' }));
  const child = spawnSync(process.execPath, ['--import', preload, 'scripts/staging/worker.mjs', command], {
    encoding: 'utf8', env: { ...process.env, MS_TABLES: tables, CLOUDFLARE_ACCOUNT_ID: 'test-account', CLOUDFLARE_API_TOKEN: 'synthetic', MAILSTACK_STAGING_STATE: dir, ...(ses ? { MAILSTACK_STAGING_DELIVERY: 'ses', SES_ACCESS_KEY_ID: 'synthetic-ses-id', SES_SECRET_ACCESS_KEY: 'synthetic-ses-secret' } : {}), ...extra, MAILSTACK_STAGING_BRANCH: 'HEAD', MAILSTACK_STAGING_COMMIT: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() },
  });
  return { child, dir };
}
it('stops deployment after the first changed production fingerprint', () => {
  const { child, dir } = run('deploy', true);
  expect(child.status).not.toBe(0);
  expect(child.stderr).toContain('Production fingerprint changed');
  expect(readdirSync(dir).filter(value => value.startsWith('mutation-'))).toHaveLength(1);
});
it('uses the shared deployment schema runner', () => {
  const { child, dir } = run('deploy');
  expect(child.status, child.stderr).toBe(0);
  expect(readFileSync(join(dir, 'queries.jsonl'), 'utf8')).toContain('CREATE TABLE IF NOT EXISTS erasure_registry');
  expect(readFileSync(join(dir, 'queries.jsonl'), 'utf8')).toContain('ADD COLUMN error TEXT');
});
it('deploys isolated resources with a record for each write', () => {
  const { child, dir } = run('deploy');
  expect(child.status, child.stderr).toBe(0);
  const records = mutations(dir).map(value => JSON.parse(readFileSync(join(dir, value), 'utf8')));
  expect(records.map(value => value.label).filter(label => label !== 'migrate-schema')).toEqual(['create-database', 'upload-worker', 'set-cron', 'disable-workers-dev', 'attach-domain']);
  expect(records.some(value => value.label === 'migrate-schema')).toBe(true);
  expect(records.every(value => value.identical)).toBe(true);
  expect(child.stdout).not.toContain('synthetic');
  const [commit] = readdirSync(join(dir, 'source'));
  const docs = join(dir, 'source', commit, 'docs');
  expect(readdirSync(docs)).toEqual(['sources']);
  const presets = readdirSync(join(docs, 'sources'));
  expect(presets).toContain('sellf.json');
  expect(presets.every(file => file.endsWith('.json'))).toBe(true);
  for (const file of presets) {
    expect(readFileSync(join(docs, 'sources', file), 'utf8')).toBe(
      execFileSync('git', ['show', `${commit}:docs/sources/${file}`], { encoding: 'utf8' }),
    );
  }
});
it('uses the full key with the Sellf signature and no scoped clients', () => {
  const { dir } = run('deploy');
  const config = JSON.parse(readFileSync(join(dir, 'mailstack.json'), 'utf8'));
  expect(config.clients).toBeUndefined();
  expect(parseConfig(config).legacyApiKey).toMatchObject({ enabled: true, env: 'API_KEY', signatureSecretEnv: 'SELLF_STAGING_HMAC' });
  const secrets = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'));
  expect(Object.keys(secrets)).toContain('API_KEY');
  expect(Object.keys(secrets)).not.toContain('SEND_TOKEN');
  const bindings = JSON.parse(readFileSync(join(dir, 'uploaded-bindings.json'), 'utf8'));
  expect(bindings).toEqual(expect.arrayContaining([{ name: 'API_KEY', type: 'secret_text' }, { name: 'SELLF_STAGING_HMAC', type: 'secret_text' }]));
});
it('provisions a valid transit keyring as a Worker secret', async () => {
  const { dir } = run('deploy');
  const secrets = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'));
  expect((await parseTransitKeys(secrets.TRANSIT_KEYS)).publicKeys).toEqual([{ kid: 'staging-transit', x: expect.any(String) }]);
  const bindings = JSON.parse(readFileSync(join(dir, 'uploaded-bindings.json'), 'utf8'));
  expect(bindings).toEqual(expect.arrayContaining([{ name: 'TRANSIT_KEYS', type: 'secret_text' }]));
});
it('accepts repeated removal when recorded resources are already absent', () => {
  const { child } = run('destroy');
  expect(child.status, child.stderr).toBe(0);
});

it('limits enabled SES delivery to simulator recipients and keeps credentials out of local artifacts', () => {
  const { child, dir } = run('deploy', false, true);
  expect(child.status, child.stderr).toBe(0);
  const config = JSON.parse(readFileSync(join(dir, 'mailstack.json'), 'utf8'));
  expect(config.events.ses).toEqual({ topicArns: ['arn:aws:sns:eu-west-1:207570392857:mailstack-staging-events'], accountIds: ['207570392857'], allowSignatureV1: false });
  const bindings = JSON.parse(readFileSync(join(dir, 'uploaded-bindings.json'), 'utf8'));
  expect(bindings).toEqual(expect.arrayContaining([
    { name: 'SES_ACCESS_KEY_ID', type: 'secret_text' },
    { name: 'SES_SECRET_ACCESS_KEY', type: 'secret_text' },
    { name: 'SES_CONFIGURATION_SET', type: 'plain_text', text: 'mailstack-staging' },
  ]));
  for (const brand of Object.values(config.brands) as any[]) {
    expect(brand.from).toBe('no-reply@mailstack-test.techskills.academy');
    expect(brand.to).toEqual(['success@simulator.amazonses.com']);
    expect(brand.autoReply).toBe(false);
  }
  expect(config.logging.defaults).toMatchObject({level:'masked', requireLog:true});
  const bundle = readFileSync(join(dir, 'worker.mjs'), 'utf8');
  expect(bundle).toContain('staging_recipient_not_allowed');
  expect(bundle).toContain('staging_receiver');
  expect(bundle).toContain('receiverCleanup');
  expect(bindings).toEqual(expect.arrayContaining([
    {name:'STAGING_RECEIVER_TOKEN',type:'secret_text'},
    {name:'STAGING_RECEIVER_KEY',type:'secret_text'},
  ]));
  for (const file of readdirSync(dir).filter(f => /\.(json|mjs)$/.test(f))) {
    expect(readFileSync(join(dir, file), 'utf8')).not.toContain('synthetic-ses-secret');
  }
  expect(child.stdout + child.stderr).not.toContain('synthetic-ses-secret');
});

it('inherits default masked refund fields in the staging composition', async () => {
  const script = readFileSync('scripts/staging/worker.mjs', 'utf8');
  const assignment = script.match(/cfg\.logging\.defaults = [^;]+;/)?.[0];
  expect(assignment).toBeDefined();
  const context = { cfg: structuredClone(example) };
  runInNewContext(assignment!, context);
  const cfg = parseConfig(context.cfg);
  expect(cfg.logging.defaults.show).toBeUndefined();
  const { policy } = await resolvePolicy(cfg.logging, 'acme', 'refund');
  const archive = projectArchive({ policy, patterns: [], brand: cfg.brands.acme, template: getTemplate('refund')!,
    data: { amount: '123.00', currency: 'PLN', productName: 'Pakiet', isFullRefund: 'true', reason: 'PRIVATE-REASON' } });
  if (!archive || archive.level === 'meta') throw Error('Expected content archive');
  for (const output of [archive.html, archive.text]) {
    expect(output).toContain('123.00 PLN');
    expect(output).toContain('Zakres zwrotu: pełny.');
    expect(output).toContain('Powód: [ukryte]');
    expect(output).not.toContain('PRIVATE-REASON');
  }
});

it('N: the staging bundle serves the panel binding through Internal with the panel gate and no staging routes', async () => {
  const { child, dir } = run('deploy');
  expect(child.status, child.stderr).toBe(0);
  const id = 'A'.repeat(43), mf = new Miniflare(convertV4MiniflareOptions({ workers: [
    { name: 'panel', modules: true, compatibilityDate: '2026-10-26', serviceBindings: { API: { name: 'api', entrypoint: 'Internal' } },
      script: 'export default { fetch(req, env) { return env.API.fetch(req); } }' },
    { name: 'api', modules: true, compatibilityDate: '2026-10-26', compatibilityFlags: ['nodejs_compat'], script: readFileSync(join(dir, 'worker.mjs'), 'utf8'), d1Databases: ['DB'],
      bindings: { ...panelEnv, API_KEY: 'full-key', STAGING_RECEIVER_TOKEN: id, STAGING_RECEIVER_KEY: id } },
  ] }));
  try {
    const panel = await mf.getWorker('panel'), api = await mf.getWorker('api'), full = { headers: { authorization: 'Bearer full-key' } };
    expect((await panel.fetch('https://api.internal/internal/v2/capabilities')).status).toBe(401);
    expect((await panel.fetch('https://api.internal/internal/v2/capabilities', full)).status).toBe(403);
    expect((await panel.fetch('https://api.internal/_staging/jwks')).status).toBe(404);
    expect((await panel.fetch('https://api.internal/health')).status).toBe(404);
    expect((await api.fetch('https://api.internal/_staging/jwks')).status).toBe(200);
    expect((await api.fetch('https://api.internal/internal/v2/capabilities', full)).status).toBe(404);
  } finally { await mf.dispose(); }
}, 60000);

const REGISTER = { MAILSTACK_STAGING_B2_KEY_ID: 'synthetic-b2-id', MAILSTACK_STAGING_B2_APP_KEY: 'synthetic-b2-key', MAILSTACK_STAGING_AGE_RECIPIENT: 'age1synthetic' };
it('configures and initializes the erasure register under the staging prefix', () => {
  const { child, dir } = run('deploy', false, false, '', REGISTER);
  expect(child.status, child.stderr).toBe(0);
  const secrets = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8'));
  expect(secrets).toMatchObject({ B2_KEY_ID: 'synthetic-b2-id', B2_APP_KEY: 'synthetic-b2-key', BACKUP_AGE_RECIPIENT: 'age1synthetic' });
  expect(secrets.TOMBSTONE_REGISTRY_ID).toMatch(/^[a-f0-9]{32}$/);
  const bindings = JSON.parse(readFileSync(join(dir, 'uploaded-bindings.json'), 'utf8'));
  expect(bindings).toEqual(expect.arrayContaining([{ name: 'TOMBSTONE_REGISTRY_ID', type: 'secret_text' }, { name: 'B2_APP_KEY', type: 'secret_text' },
    { name: 'TOMBSTONE_PREFIX', type: 'plain_text', text: 'staging-tombstones/' }, { name: 'B2_BUCKET', type: 'plain_text', text: 'mailstack-staging-backup-f3c750' }]));
  expect(readFileSync(join(dir, 'b2.log'), 'utf8').trim().split('\n')).toEqual(['GET /mailstack-staging-backup-f3c750/', 'PUT /mailstack-staging-backup-f3c750/staging-tombstones/genesis', 'PUT /mailstack-staging-backup-f3c750/staging-tombstones/head']);
  expect(child.stdout + child.stderr).not.toContain('synthetic-b2-key');
});
it('N: without register inputs the deployment leaves the register unconfigured', () => {
  const { child, dir } = run('deploy');
  expect(child.status, child.stderr).toBe(0);
  const bindings = JSON.parse(readFileSync(join(dir, 'uploaded-bindings.json'), 'utf8'));
  expect(bindings.map((b: { name: string }) => b.name)).not.toEqual(expect.arrayContaining(['TOMBSTONE_REGISTRY_ID']));
  expect(bindings.map((b: { name: string }) => b.name)).not.toEqual(expect.arrayContaining(['B2_BUCKET']));
});
it('enables resend replay and source for acme in the Pro staging composition', async () => {
  const script = readFileSync('scripts/staging/worker.mjs', 'utf8');
  const assignment = script.match(/cfg\.logging\.brands = [^;]+;/)?.[0];
  expect(assignment).toBeDefined();
  const context = { cfg: structuredClone(example) };
  runInNewContext(script.match(/cfg\.logging\.defaults = [^;]+;/)![0] + assignment!, context);
  const cfg = parseConfig(context.cfg);
  expect((await resolvePolicy(cfg.logging, 'acme', 'notice')).policy.resend).toBe('replay');
  expect((await resolvePolicy(cfg.logging, 'acme', 'payment')).policy.resend).toBe('replay');
  expect((await resolvePolicy(cfg.logging, 'acme', 'license')).policy.resend).toBe('source');
  expect((await resolvePolicy(cfg.logging, 'demo', 'notice')).policy.resend).toBe('off');
  expect(script).toMatch(/id: 'st-source'[^\n]+resendCallback: \{ url: `https:\/\/\$\{hostname\}\/_staging\/receiver\/\$\{secrets\.STAGING_RECEIVER_TOKEN\}\/resend`, secretEnv: 'STAGING_RESEND_SECRET' \}/);
});
