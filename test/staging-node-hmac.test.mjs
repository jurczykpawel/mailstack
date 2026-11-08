import {stagingEnv} from './fixtures/staging.ts';
import {expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
it.each(['stopped','missing','multiple'])('swaps and restores the Node staging HMAC after an interrupted recreation: %s',(state)=>{
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
os.hostname=()=> 'staging-host';
let recreated=false;
cp.execFileSync=(_cmd,args)=>{
 if(args[0]==='inspect'){
   if(args.length<2||args.slice(1).some(id=>!['api','old','replacement'].includes(id)))throw Error('Expected separate existing container IDs');
   return JSON.stringify(args.slice(1).map(Id=>({Id,Config:{Labels:{'com.docker.compose.project.working_dir':process.env.WRONG_IDENTITY&&Id!=='old'?'/other-stack':stack,'com.docker.compose.service':'api'},Env:['SELLF_STAGING_HMAC='+fs.readFileSync(dir+'/live','utf8')]}})));
 }
 if(args[0]==='exec'&&process.env.STOPPED)throw Error('API stopped');
 if(args[0]==='exec'&&args.at(-1)!=="process.stdout.write(require('node:fs').readFileSync(process.env.MAILSTACK_CONFIG,'utf8'))")throw Error('Expected container runtime config lookup');
 if(args[0]==='exec')return JSON.stringify({clients:[{id:'staging-hook',scopes:['hook:sellf'],signatureSecretEnv:'SELLF_STAGING_HMAC'}]});
 if(args.includes('ps'))return !recreated&&process.env.RECOVERY_STATE==='missing'?'':!recreated&&process.env.RECOVERY_STATE==='multiple'?'old\\nreplacement':'api';
 if(args.includes('up')){
   if(JSON.stringify(args)!==JSON.stringify(['compose','up','-d','--no-deps','--force-recreate','api']))throw Error('Expected API recreation only');
   if(process.env.FAIL_RESTART)throw Error('Interrupted restart');
   recreated=true; fs.appendFileSync(dir+'/recreations','api\\n');
   fs.writeFileSync(dir+'/live',fs.readFileSync(dir+'/.env','utf8').match(/SELLF_STAGING_HMAC=(.+)/)[1]);return '';
 }
 throw Error('Unexpected command');
};
globalThis.fetch=async(url,opts)=>{
 if(url.startsWith('https://api.cloudflare.com/'))return Response.json({success:true,result:{id:'unchanged'}});
 if(!url.startsWith('https://node.staging.example.com/'))throw Error('Unexpected address');
 fs.appendFileSync(dir+'/probes','probe\\n');
 const signature=opts.headers['X-Sellf-Signature'],t=signature.match(/t=(\\d+)/)[1];
 const expected=createHmac('sha256',fs.readFileSync(dir+'/live','utf8')).update(t+'.'+opts.body).digest('hex');
 return signature.endsWith(expected)?Response.json({success:true,ignored:'staging.hmac.probe'}):Response.json({success:false},{status:401});
}; syncBuiltinESMExports();`);
  const run=(command,fail=false,wrong=false)=>spawnSync(process.execPath,['--import',preload,'scripts/staging/node.mjs',command],{
    encoding:'utf8',input:temporary,env:{...process.env,...stagingEnv,MAILSTACK_STAGING_OPERATOR:undefined,MAILSTACK_STAGING_ACCOUNT_ID:undefined,MAILSTACK_STAGING_HOOK_TOKEN:'hook',CLOUDFLARE_API_TOKEN:'cf',...(fail?{FAIL_RESTART:'1'}:command==='hmac-restore'?{STOPPED:'1',RECOVERY_STATE:state,...(wrong?{WRONG_IDENTITY:'1'}:{})}:{})}});
  try {
    const failed=run('hmac-swap',true); expect(failed.status).not.toBe(0);
    expect(existsSync(join(dir,'hmac-recovery/hmac-backup.json'))).toBe(true);
    if(state!=='missing') {
      const refused=run('hmac-restore',false,true); expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain('Staging Compose identity differs');
      expect(existsSync(join(dir,'hmac-recovery/hmac-backup.json'))).toBe(true);
      expect(existsSync(join(dir,'recreations'))).toBe(false);
    }
    const restored=run('hmac-restore'); expect(restored.status,restored.stderr).toBe(0);
    expect(readFileSync(join(dir,'.env'),'utf8')).toBe(`OTHER=keep\nSELLF_STAGING_HMAC=${original}\n`);
    expect(readFileSync(join(dir,'live'),'utf8')).toBe(original);
    expect(readFileSync(join(dir,'recreations'),'utf8')).toBe('api\n');
    expect(readFileSync(join(dir,'probes'),'utf8').trim().split('\n')).toHaveLength(4);
    expect(existsSync(join(dir,'hmac-recovery/hmac-backup.json'))).toBe(false);
    const swapped=run('hmac-swap'); expect(swapped.status,swapped.stderr).toBe(0);
    expect(run('hmac-restore').status).toBe(0);
    expect(swapped.stdout+restored.stdout).not.toContain(temporary);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
