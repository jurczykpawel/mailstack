import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,renameSync,statSync} from 'node:fs';
import {hostname} from 'node:os';
import {changeHmac,verifyHmac,productionFingerprint} from './hmac.mjs';
const command=process.argv[2], stack='/opt/stacks/mailstack-staging';
if(!['hmac-swap','hmac-restore'].includes(command)||hostname()!=='piotr293') throw Error('Run hmac-swap|hmac-restore on piotr293 staging host');
const envName=process.env.MAILSTACK_STAGING_HMAC_ENV ?? 'SELLF_STAGING_HMAC';
if(!/^[A-Z][A-Z0-9_]{1,63}$/.test(envName)) throw Error('Invalid HMAC environment name');
const token=process.env.MAILSTACK_STAGING_HOOK_TOKEN, cfToken=process.env.CLOUDFLARE_API_TOKEN;
if(!token||!cfToken) throw Error('Staging hook token and Cloudflare read token required in environment');
process.umask(0o077);
const docker=args=>execFileSync('docker',args,{cwd:stack,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const inspect=()=>{
  const ids=docker(['compose','ps','-a','-q','api']).split(/\s+/).filter(Boolean);
  const containers=ids.map(id=>JSON.parse(docker(['inspect',id]))[0]);
  for(const container of containers) {
    const labels=container.Config.Labels;
    if(labels['com.docker.compose.project.working_dir']!==stack||labels['com.docker.compose.service']!=='api') throw Error('Staging Compose identity differs');
  }
  return containers;
};
const requireOne=containers=>{
  if(containers.length!==1) throw Error('Expected exactly one staging API container');
  return containers[0];
};
const containers=inspect(), container=command==='hmac-swap'?requireOne(containers):undefined;
if(command==='hmac-swap') {
  const config=JSON.parse(docker(['exec',container.Id,'node','-e',"process.stdout.write(require('node:fs').readFileSync(process.env.MAILSTACK_CONFIG,'utf8'))"]));
  const client=config.clients?.find(c=>c.id==='staging-hook');
  if(!client||!(client.scopes??[]).includes('hook:sellf')||(client.signatureSecretEnv??client.sellfSignatureSecretEnv)!==envName) throw Error('Configure the dedicated staging-hook HMAC binding first');
}
const path=stack+'/.env', pattern=new RegExp(`^${envName}=([A-Za-z0-9_-]{16,256})$`,'m');
const current=()=>{
  const text=readFileSync(path,'utf8'), match=text.match(pattern);
  if(!match||text.split('\n').filter(line=>line.startsWith(envName+'=')).length!==1) throw Error('Expected one plain HMAC entry in staging .env');
  return {text,value:match[1]};
};
const original=current();
if(command==='hmac-swap'&&!container.Config.Env.includes(`${envName}=${original.value}`)) throw Error('Staging .env and running HMAC differ');
const temporary=command==='hmac-swap'?readFileSync(0,'utf8').trim():undefined;
if(temporary&&!/^[A-Za-z0-9_-]{16,256}$/.test(temporary)) throw Error('Invalid temporary HMAC format');
await changeHmac(command,temporary,{
  dir:stack+'/hmac-recovery',identity:'piotr293:'+stack+':'+envName,
  fingerprint:()=>productionFingerprint('92e7018cfc666807c755836278d19eaf',cfToken),read:async()=>current().value,
  apply:async value=>{
    const {text}=current();
    writeFileSync(path+'.hmac-next',text.replace(pattern,`${envName}=${value}`),{mode:statSync(path).mode&0o777});
    renameSync(path+'.hmac-next',path);
    docker(['compose','up','-d','--no-deps','--force-recreate','api']);
    if(!requireOne(inspect()).Config.Env.includes(`${envName}=${value}`)) throw Error('Compose must reference the staging HMAC environment entry');
  },
  verify:(active,inactive)=>verifyHmac('https://mailstack-test.tojest.dev',token,active,inactive),
});
console.log(`${command}: verified; production IDENTICAL`);
