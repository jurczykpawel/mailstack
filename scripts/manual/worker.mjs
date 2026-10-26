import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, cpSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, generateKeyPairSync, createHash } from 'node:crypto';
import { build } from 'esbuild';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '../..'), state='/private/tmp/mailstack-test-worker';
const command=process.argv[2] ?? 'status';
if(!['deploy','destroy','status'].includes(command)) throw new Error('Use deploy|destroy|status');
process.umask(0o077); mkdirSync(state,{recursive:true,mode:0o700});
const put=(p,v)=>writeFileSync(state+'/'+p,typeof v==='string'?v:JSON.stringify(v,null,2),{mode:0o600});
let token;
try { token=execFileSync('bw',['get','password','CF Deploy - General API token'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim(); }
catch { console.error('TEST-WORKER skipped: agent Vaultwarden token is unavailable. No Cloudflare mutations.'); process.exit(3); }
if(!token) process.exit(3);
const env={PATH:process.env.PATH,HOME:process.env.HOME,CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:'92e7018cfc666807c755836278d19eaf',WRANGLER_SEND_METRICS:'false',CI:'true',NO_COLOR:'1'};
const wr=(args)=>execFileSync(root+'/node_modules/.bin/wrangler',args,{cwd:state,env,encoding:'utf8',maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']});
const json=raw=>{const start=raw.search(/[\[{]/);return JSON.parse(raw.slice(start));};
put('readonly.json',{name:'mailstack-test',compatibility_date:'2026-10-26',account_id:env.CLOUDFLARE_ACCOUNT_ID});
let before;
try { before=json(wr(['deployments','list','--name','mailstack','--json','--config',state+'/readonly.json'])); }
catch { console.error('TEST-WORKER skipped: cannot read production deployment fingerprint; no mutation allowed.');process.exit(3); }
put('production-before.json',before);
let failed=false;
try {
  if(command==='deploy') {
    const list=json(wr(['d1','list','--json','--config',state+'/readonly.json']));
    const database=list.find(d=>d.name==='mailstack-preview');
    if(!database || !/^[a-f0-9-]{36}$/.test(database.uuid)) throw new Error('Isolated preview database unavailable');
    const cfg=JSON.parse(readFileSync(root+'/config/mailstack.example.json','utf8'));
    for(const brand of Object.values(cfg.brands)) {brand.captcha='altcha';brand.allowedOrigins=['https://'+brand.id+'.example','http://localhost:18882'];brand.autoReply=false;}
    cfg.brands['selfware-like']={...cfg.brands.demo,id:'selfware-like',requireNonce:true,products:['Produkt Żółw','Test Pro'],allowedOrigins:['https://selfware.example','http://localhost:18882']};
    cfg.sender={type:'ses'};cfg.logging.defaults.level='masked';cfg.logging.defaults.requireLog=true;
    cfg.legacyApiKey={enabled:true,env:'API_KEY'};
    const pair=generateKeyPairSync('x25519'),kid='worker-test-content';
    const secrets=existsSync(state+'/secrets.json')?JSON.parse(readFileSync(state+'/secrets.json')):{
      API_KEY:randomBytes(32).toString('base64url'),ALTCHA_HMAC_KEY:randomBytes(32).toString('base64url'),
      SES_ACCESS_KEY_ID:'TEST'+randomBytes(12).toString('hex'),SES_SECRET_ACCESS_KEY:randomBytes(32).toString('base64url'),
      TURNSTILE_SECRET:'1x0000000000000000000000000000000AA',
      CONTENT_PUBLIC_KEYS:JSON.stringify({keys:[{...pair.publicKey.export({format:'jwk'}),kid}]}),
      INDEX_KEYS:JSON.stringify([{kid:'worker-test-index',key:randomBytes(32).toString('base64url')}]),
    };
    if(!existsSync(state+'/secrets.json')) put('content-private.json',{keys:[{...pair.privateKey.export({format:'jwk'}),kid}]});
    put('secrets.json',secrets);put('mailstack.json',cfg);
    const configJSON=JSON.stringify(cfg),sha=createHash('sha256').update(configJSON).digest('hex');
    await build({entryPoints:[root+'/src/index.ts'],outfile:state+'/worker.mjs',bundle:true,platform:'browser',format:'esm',conditions:['workerd','worker','browser'],external:['node:*'],plugins:[{name:'isolated-test-config',setup(b){
      b.onResolve({filter:/\/bundled\.ts$/},()=>({path:'config',namespace:'manual-test'}));
      b.onLoad({filter:/.*/,namespace:'manual-test'},()=>({contents:'export const CONFIG_JSON='+JSON.stringify(configJSON)+'; export const BUILD_CONFIG_SHA='+JSON.stringify(sha)+';'}));
      b.onResolve({filter:/\/assets\/logo$/},()=>({path:root+'/src/assets/logo.example.ts'}));
    }}]});
    mkdirSync(state+'/migrations',{recursive:true});cpSync(root+'/.wrangler/migrations/0001_initial.sql',state+'/migrations/0001_initial.sql');
    const conf={name:'mailstack-test',main:state+'/worker.mjs',compatibility_date:'2026-10-26',compatibility_flags:['nodejs_compat'],workers_dev:true,routes:[],
      account_id:env.CLOUDFLARE_ACCOUNT_ID,vars:{SES_REGION:'eu-west-1',BUILD_CONFIG_SHA:sha,BUILD_COMMIT:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),SELLF_DEFAULT_BRAND:'acme'},
      d1_databases:[{binding:'DB',database_name:'mailstack-preview',database_id:database.uuid,migrations_dir:state+'/migrations'}],observability:{enabled:false}};
    put('wrangler.json',conf);
    put('migration.log',wr(['d1','migrations','apply','DB','--remote','--config',state+'/wrangler.json']));
    put('deploy.log',wr(['deploy','--config',state+'/wrangler.json','--no-bundle','--secrets-file',state+'/secrets.json']));
    const match=readFileSync(state+'/deploy.log','utf8').match(/https:\/\/mailstack-test\.[a-z0-9-]+\.workers\.dev/);
    if(!match) throw new Error('Cannot identify isolated workers.dev address');
    const url=match[0];
    let r, body;
    for(let attempt=0;attempt<12;attempt++) {
      r=await fetch(url+'/altcha/challenge?brand=selfware-like&product='+encodeURIComponent('Produkt Żółw'),{headers:{Origin:'https://selfware.example'},signal:AbortSignal.timeout(15000)});
      const raw=await r.text();try { body=JSON.parse(raw); } catch { body={error:'Non-JSON response during propagation'}; }
      if(r.status===200 && body.nonce && body.altcha) break;
      await new Promise(done=>setTimeout(done,5000));
    }
    put('smoke.json',{status:r.status,body});
    if(r.status!==200 || !body.nonce || !body.altcha) throw new Error('Nonce challenge smoke failed');
    put('status.json',{url,tokens:{legacy:secrets.API_KEY},database:'mailstack-preview',productionUntouched:true});
    console.log('TEST-WORKER ready. Credentials and URL: '+state+'/status.json (0600)');
  } else if(command==='destroy') {
    if(existsSync(state+'/wrangler.json')) put('destroy.log',wr(['delete','--name','mailstack-test','--config',state+'/wrangler.json','--force']));
    console.log('TEST-WORKER removed; existing preview D1 retained. Local test secrets removed.');
  } else {
    console.log(existsSync(state+'/status.json')?'TEST-WORKER status and credentials: '+state+'/status.json':'TEST-WORKER has no local deployment record');
  }
} catch(error) {
  failed=true;
  put('failure.log', String(error.stderr ?? error.message));
  console.error('TEST-WORKER operation failed; details in '+state+'/failure.log. Local environment remains independent.');
} finally {
  try {
    const after=json(wr(['deployments','list','--name','mailstack','--json','--config',state+'/readonly.json']));
    put('production-after.json',after);
    if(JSON.stringify(before)!==JSON.stringify(after)) {failed=true;console.error('STOP: production deployment fingerprint changed.');}
    else {put('production-comparison.txt','IDENTICAL\n');console.log('Production deployments: IDENTICAL before/after.');}
  } catch {failed=true;console.error('Cannot verify production fingerprint after operation.');}
  if(command==='destroy'&&!failed) {
    for(const file of ['secrets.json','content-private.json','status.json']) rmSync(state+'/'+file,{force:true});
  }
}
process.exitCode=failed?1:0;
