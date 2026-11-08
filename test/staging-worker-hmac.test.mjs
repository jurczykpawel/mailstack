import {expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync,readdirSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
it.each(['complete', 'swap-partial', 'swap-interrupted', 'swap-rename', 'restore-partial', 'restore-interrupted', 'restore-rename'])('keeps the Worker secret copy recoverable: %s',scenario=>{
  const dir=mkdtempSync(join(tmpdir(),'worker-hmac-')),preload=join(dir,'mock.mjs');
  const original='original_secret_123456',temporary='temporary_secret_123456';
  writeFileSync(join(dir,'resources.json'),JSON.stringify({account:'test',name:'mailstack-staging',hostname:'mailstack-test.techskills.academy',database:'dedicated'}));
  writeFileSync(join(dir,'secrets.json'),JSON.stringify({API_KEY:'full',SELLF_STAGING_HMAC:original,OTHER:'preserve'}));
  writeFileSync(join(dir,'live'),original);
  writeFileSync(preload,`import fs, {readFileSync,writeFileSync,appendFileSync} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {createHmac} from 'node:crypto';
const dir=${JSON.stringify(dir)};
const failure=process.env.LOCAL_WRITE_FAILURE;
if(failure) {
 const write=fs.writeFileSync,rename=fs.renameSync;
 fs.writeFileSync=(path,data,options)=>{
   if(typeof path==='string'&&path.startsWith(dir+'/secrets.json')&&failure!=='rename') {
     write(path,String(data).slice(0,12),options);
     if(failure==='interrupted')process.exit(77);
     throw Error('Local partial write');
   }
   return write(path,data,options);
 };
 fs.renameSync=(from,to)=>{if(to===dir+'/secrets.json'&&failure==='rename')throw Error('Local rename failure');return rename(from,to);};
 syncBuiltinESMExports();
}
globalThis.fetch=async(url,options={})=>{
 if(new URL(url).hostname==='mailer.techskills.academy')return Response.json({ok:true});
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
   if(options.headers.authorization!=='Bearer full')return Response.json({success:false},{status:401});
   const signature=options.headers['X-Sellf-Signature'],t=signature.match(/t=(\\d+)/)[1];
   const expected=createHmac('sha256',readFileSync(dir+'/live','utf8')).update(t+'.'+options.body).digest('hex');
   return signature.endsWith(expected)?Response.json({success:true,ignored:'staging.hmac.probe'}):Response.json({success:false},{status:401});
 }
 throw Error('Unexpected request');
};`);
  const run=(command,failure='')=>spawnSync(process.execPath,['--import',preload,'scripts/staging/worker.mjs',command],{
    encoding:'utf8',input:temporary,env:{...process.env,MAILSTACK_STAGING_STATE:dir,MAILSTACK_STAGING_ROUTING:'custom-domain',CLOUDFLARE_ACCOUNT_ID:'test',CLOUDFLARE_API_TOKEN:'local',MAILSTACK_PRODUCTION_API_TOKEN:'local-production',LOCAL_WRITE_FAILURE:failure}});
  try {
    const [phase,failure]=scenario.split('-');
    if(phase==='swap') {
      const before=readFileSync(join(dir,'secrets.json'),'utf8');
      const failed=run('hmac-swap',failure);expect(failed.status).not.toBe(0);
      expect(readFileSync(join(dir,'secrets.json'),'utf8')).toBe(before);
      expect(existsSync(join(dir,'hmac-backup.json'))).toBe(true);
      if(failure==='interrupted') {
        const pending=readdirSync(dir).filter(name=>name.startsWith('secrets.json.'));
        expect(pending).toHaveLength(1);
        expect(statSync(join(dir,pending[0])).mode&0o777).toBe(0o600);
        rmSync(join(dir,'hmac.lock'));
      }
      const restored=run('hmac-restore');expect(restored.status,restored.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(dir,'secrets.json')))).toEqual({API_KEY:'full',SELLF_STAGING_HMAC:original,OTHER:'preserve'});
      expect(readFileSync(join(dir,'live'),'utf8')).toBe(original);
      return;
    }
    const swap=run('hmac-swap');expect(swap.status,swap.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dir,'secrets.json'))).SELLF_STAGING_HMAC).toBe(temporary);
    if(phase==='restore') {
      const before=readFileSync(join(dir,'secrets.json'),'utf8');
      const failed=run('hmac-restore',failure);expect(failed.status).not.toBe(0);
      expect(readFileSync(join(dir,'secrets.json'),'utf8')).toBe(before);
      expect(existsSync(join(dir,'hmac-backup.json'))).toBe(true);
      expect(readFileSync(join(dir,'live'),'utf8')).toBe(temporary);
      if(failure==='interrupted')rmSync(join(dir,'hmac.lock'));
    }
    const restore=run('hmac-restore');expect(restore.status,restore.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dir,'secrets.json')))).toMatchObject({SELLF_STAGING_HMAC:original,OTHER:'preserve'});
    expect(statSync(join(dir,'secrets.json')).mode&0o777).toBe(0o600);
    expect(existsSync(join(dir,'hmac-backup.json'))).toBe(false);
    expect(readFileSync(join(dir,'writes'),'utf8')).toBe('SELLF_STAGING_HMAC\nSELLF_STAGING_HMAC\n');
    expect(swap.stdout+restore.stdout).not.toContain(temporary);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
