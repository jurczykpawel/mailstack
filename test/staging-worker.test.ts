import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function run(command: string, change = false) {
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
writes++;return response({uuid:'staging-database'});
};`);
  if (command === 'destroy') writeFileSync(join(dir, 'resources.json'), JSON.stringify({ account: 'test-account', name: 'mailstack-staging', database: 'staging-database' }));
  const child = spawnSync(process.execPath, ['--import', preload, 'scripts/staging/worker.mjs', command], {
    encoding: 'utf8', env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: 'test-account', CLOUDFLARE_API_TOKEN: 'synthetic', MAILSTACK_STAGING_STATE: dir, MAILSTACK_STAGING_COMMIT: execFileSync('git', ['merge-base', 'HEAD', 'main'], { encoding: 'utf8' }).trim() },
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
