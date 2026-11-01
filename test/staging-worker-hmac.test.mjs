import {expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
it('updates only the Worker HMAC binding and restores the protected secret copy',()=>{
  const dir=mkdtempSync(join(tmpdir(),'worker-hmac-')),preload=join(dir,'mock.mjs');
  const original='original_secret_123456',temporary='temporary_secret_123456';
  writeFileSync(join(dir,'resources.json'),JSON.stringify({account:'test',name:'mailstack-staging',database:'dedicated'}));
  writeFileSync(join(dir,'secrets.json'),JSON.stringify({HOOK_TOKEN:'hook',SELLF_STAGING_HMAC:original,OTHER:'preserve'}));
  writeFileSync(join(dir,'live'),original);
  writeFileSync(preload,`import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';import {createHmac} from 'node:crypto';
const dir=${JSON.stringify(dir)};
globalThis.fetch=async(url,options={})=>{
 const path=new URL(url).pathname;
 const response=result=>Response.json({success:true,result});
 if(path.endsWith('/mailstack/deployments'))return response({id:'unchanged'});
 if(path.endsWith('/d1/database'))return response([{name:'mailstack-staging',uuid:'dedicated'}]);
 if(path.endsWith('/workers/domains'))return response([{hostname:'mailstack-test.techskills.academy',service:'mailstack-staging'}]);
 if(path.endsWith('/mailstack-staging/secrets')&&options.method==='PUT'){
   const value=JSON.parse(options.body);if(value.name!=='SELLF_STAGING_HMAC'||value.type!=='secret_text')throw Error('Unexpected binding');
   writeFileSync(dir+'/live',value.text);appendFileSync(dir+'/writes',value.name+'\\n');return response({});
 }
 if(path==='/v1/hooks/sellf'){
   const signature=options.headers['X-Sellf-Signature'],t=signature.match(/t=(\\d+)/)[1];
   const expected=createHmac('sha256',readFileSync(dir+'/live','utf8')).update(t+'.'+options.body).digest('hex');
   return signature.endsWith(expected)?Response.json({success:true,ignored:'staging.hmac.probe'}):Response.json({success:false},{status:401});
 }
 throw Error('Unexpected request');
};`);
  const run=command=>spawnSync(process.execPath,['--import',preload,'scripts/staging/worker.mjs',command],{
    encoding:'utf8',input:temporary,env:{...process.env,MAILSTACK_STAGING_STATE:dir,CLOUDFLARE_ACCOUNT_ID:'test',CLOUDFLARE_API_TOKEN:'local'}});
  try {
    const swap=run('hmac-swap');expect(swap.status,swap.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dir,'secrets.json'))).SELLF_STAGING_HMAC).toBe(temporary);
    const restore=run('hmac-restore');expect(restore.status,restore.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dir,'secrets.json')))).toMatchObject({SELLF_STAGING_HMAC:original,OTHER:'preserve'});
    expect(readFileSync(join(dir,'writes'),'utf8')).toBe('SELLF_STAGING_HMAC\nSELLF_STAGING_HMAC\n');
    expect(swap.stdout+restore.stdout).not.toContain(temporary);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
