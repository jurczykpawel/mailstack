import {expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
it('swaps and restores only the Node staging HMAC with a recoverable interrupted restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'node-hmac-')), preload=join(dir,'mock.mjs');
  const original='original_secret_123456',temporary='temporary_secret_123456';
  writeFileSync(join(dir,'.env'),`OTHER=keep\nSELLF_STAGING_HMAC=${original}\n`);
  writeFileSync(join(dir,'live'),original);
  writeFileSync(preload,`import fs from 'node:fs'; import cp from 'node:child_process'; import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module'; import {createHmac} from 'node:crypto';
const dir=${JSON.stringify(dir)}, stack='/opt/stacks/mailstack-staging';
for(const key of ['readFileSync','writeFileSync','renameSync','statSync','mkdirSync','openSync','unlinkSync']) {
 const original=fs[key]; fs[key]=(...args)=>original(...args.map((a,i)=>(i===0||key==='renameSync'&&i===1)&&typeof a==='string'&&a.startsWith(stack)?dir+a.slice(stack.length):a));
}
os.hostname=()=> 'piotr293';
cp.execFileSync=(_cmd,args)=>{
 if(args[0]==='inspect')return JSON.stringify([{Id:'api',Config:{Labels:{'com.docker.compose.project.working_dir':stack},Env:['SELLF_STAGING_HMAC='+fs.readFileSync(dir+'/live','utf8')]}}]);
 if(args[0]==='exec'&&process.env.STOPPED)throw Error('API stopped');
 if(args[0]==='exec')return JSON.stringify({clients:[{id:'staging-hook',scopes:['hook:sellf'],signatureSecretEnv:'SELLF_STAGING_HMAC'}]});
 if(args.includes('ps'))return 'api';
 if(args.includes('up')){
   if(process.env.FAIL_RESTART)throw Error('Interrupted restart');
   fs.writeFileSync(dir+'/live',fs.readFileSync(dir+'/.env','utf8').match(/SELLF_STAGING_HMAC=(.+)/)[1]);return '';
 }
 throw Error('Unexpected command');
};
globalThis.fetch=async(url,opts)=>{
 if(url.startsWith('https://api.cloudflare.com/'))return Response.json({success:true,result:{id:'unchanged'}});
 if(!url.startsWith('https://mailstack-test.tojest.dev/'))throw Error('Unexpected address');
 const signature=opts.headers['X-Sellf-Signature'],t=signature.match(/t=(\\d+)/)[1];
 const expected=createHmac('sha256',fs.readFileSync(dir+'/live','utf8')).update(t+'.'+opts.body).digest('hex');
 return signature.endsWith(expected)?Response.json({success:true,ignored:'staging.hmac.probe'}):Response.json({success:false},{status:401});
}; syncBuiltinESMExports();`);
  const run=(command,fail=false)=>spawnSync(process.execPath,['--import',preload,'scripts/staging/node.mjs',command],{
    encoding:'utf8',input:temporary,env:{...process.env,MAILSTACK_STAGING_HOOK_TOKEN:'hook',CLOUDFLARE_API_TOKEN:'cf',...(fail?{FAIL_RESTART:'1'}:command==='hmac-restore'?{STOPPED:'1'}:{})}});
  try {
    const failed=run('hmac-swap',true); expect(failed.status).not.toBe(0);
    expect(existsSync(join(dir,'hmac-recovery/hmac-backup.json'))).toBe(true);
    const restored=run('hmac-restore'); expect(restored.status,restored.stderr).toBe(0);
    expect(readFileSync(join(dir,'.env'),'utf8')).toBe(`OTHER=keep\nSELLF_STAGING_HMAC=${original}\n`);
    const swapped=run('hmac-swap'); expect(swapped.status,swapped.stderr).toBe(0);
    expect(run('hmac-restore').status).toBe(0);
    expect(swapped.stdout+restored.stdout).not.toContain(temporary);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
