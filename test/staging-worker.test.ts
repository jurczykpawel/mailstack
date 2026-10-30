import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function run(command: string, change = false, ses = false) {
  const dir = mkdtempSync(join(tmpdir(), 'mailstack-staging-')); dirs.push(dir);
  const preload = join(dir, 'mock.mjs');
  writeFileSync(preload, `let writes=0;
const response=result=>Response.json({success:true,result});
globalThis.fetch=async(url,options={})=>{
const path=new URL(url).pathname;
if(path.endsWith('/mailstack/deployments'))return response({id:${change ? "writes ? 'changed' : 'initial'" : "'initial'"}});
if(path.endsWith('/d1/database')&&(!options.method||options.method==='GET'))return response([]);
if(path.endsWith('/workers/domains')&&(!options.method||options.method==='GET'))return response([]);
if(path.endsWith('/workers/scripts')&&(!options.method||options.method==='GET'))return response([]);
if(path.endsWith('/account-settings'))return response({default_usage_model:'standard'});
if(path==='/client/v4/zones')return response([{id:'zone',account:{id:'test-account'}}]);
if(path.endsWith('/query')&&JSON.parse(options.body).sql.startsWith('SELECT'))return response([{results:[]}]);
if(path.endsWith('/workers/scripts/mailstack-staging')&&options.method==='PUT'){
 const m=JSON.parse(await options.body.get('metadata').text());
 const safe=m.bindings.map(b=>({name:b.name,type:b.type,...(b.type==='plain_text'?{text:b.text}:{})}));
 const fs=await import('node:fs');fs.writeFileSync(${JSON.stringify(join(dir, 'uploaded-bindings.json'))},JSON.stringify(safe));
}
writes++;return response({uuid:'staging-database'});
};`);
  if (command === 'destroy') writeFileSync(join(dir, 'resources.json'), JSON.stringify({ account: 'test-account', name: 'mailstack-staging', database: 'staging-database' }));
  const child = spawnSync(process.execPath, ['--import', preload, 'scripts/staging/worker.mjs', command], {
    encoding: 'utf8', env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: 'test-account', CLOUDFLARE_API_TOKEN: 'synthetic', MAILSTACK_STAGING_STATE: dir, ...(ses ? { MAILSTACK_STAGING_DELIVERY: 'ses', SES_ACCESS_KEY_ID: 'synthetic-ses-id', SES_SECRET_ACCESS_KEY: 'synthetic-ses-secret' } : {}), MAILSTACK_STAGING_COMMIT: execFileSync('git', ['merge-base', 'HEAD', 'main'], { encoding: 'utf8' }).trim() },
  });
  return { child, dir };
}
it('stops deployment after the first changed production fingerprint', () => {
  const { child, dir } = run('deploy', true);
  expect(child.status).not.toBe(0);
  expect(child.stderr).toContain('Production fingerprint changed');
  expect(readdirSync(dir).filter(value => value.startsWith('mutation-'))).toHaveLength(1);
});
it('deploys isolated resources with a record for each write', () => {
  const { child, dir } = run('deploy');
  expect(child.status, child.stderr).toBe(0);
  const records = readdirSync(dir).filter(value => value.startsWith('mutation-')).map(value => JSON.parse(readFileSync(join(dir, value), 'utf8')));
  expect(records.map(value => value.label)).toEqual(['create-database', 'migrate-database', 'upload-worker', 'set-cron', 'attach-domain']);
  expect(records.every(value => value.identical)).toBe(true);
  expect(child.stdout).not.toContain('synthetic');
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
  expect(config.clients[0].recipientOverride).toBe(true);
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
  for (const file of readdirSync(dir).filter(f => /\.(json|mjs)$/.test(f))) {
    expect(readFileSync(join(dir, file), 'utf8')).not.toContain('synthetic-ses-secret');
  }
  expect(child.stdout + child.stderr).not.toContain('synthetic-ses-secret');
});
