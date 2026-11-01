import { mkdirSync, writeFileSync, readFileSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { createHmac } from 'node:crypto';
export async function changeHmac(command, temporary, {dir, identity, read, apply, verify, fingerprint}) {
  if (!['hmac-swap','hmac-restore'].includes(command)) throw Error('Use hmac-swap|hmac-restore');
  process.umask(0o077); mkdirSync(dir,{recursive:true,mode:0o700});
  const backup=dir+'/hmac-backup.json', lock=dir+'/hmac.lock';
  const fd=openSync(lock,'wx',0o600);
  try {
    const before=await fingerprint(); let record;
    if(command==='hmac-swap') {
      const original=await read();
      if(!original || !temporary || original===temporary) throw Error('Distinct existing and temporary HMAC values required');
      record={identity,original,temporary,production:before};
      writeFileSync(backup,JSON.stringify(record),{flag:'wx',mode:0o600});
    } else {
      record=JSON.parse(readFileSync(backup,'utf8'));
      if(record.identity!==identity) throw Error('HMAC backup identity differs');
    }
    if(before!==record.production) throw Error('Production fingerprint differs from saved baseline');
    if(command==='hmac-swap') await verify(record.original,record.temporary);
    const active=command==='hmac-swap'?record.temporary:record.original;
    const inactive=command==='hmac-swap'?record.original:record.temporary;
    try { await apply(active); }
    finally {
      const after=await fingerprint();
      writeFileSync(dir+`/hmac-check-${Date.now()}.json`,JSON.stringify({identity,before,after,identical:before===after}),{mode:0o600});
      if(before!==after) throw Error('Production fingerprint changed; stop');
    }
    await verify(active,inactive);
    if(command==='hmac-restore') unlinkSync(backup);
  } finally { closeSync(fd); unlinkSync(lock); }
}
export async function verifyHmac(url, token, active, inactive) {
  const body=JSON.stringify({event:'staging.hmac.probe',timestamp:new Date().toISOString(),data:{}});
  for(let attempt=0;attempt<12;attempt++) {
    const statuses=[];
    for(const secret of [active,inactive]) {
      const t=Math.floor(Date.now()/1000), signature=createHmac('sha256',secret).update(`${t}.${body}`).digest('hex');
      const r=await fetch(url+'/v1/hooks/sellf?brand=acme',{method:'POST',body,
        headers:{authorization:`Bearer ${token}`,'content-type':'application/json','X-Sellf-Signature':`t=${t},v1=${signature}`},signal:AbortSignal.timeout(10000),redirect:'error'});
      const json=await r.json();
      statuses.push(r.status===200&&json.success===true&&json.ignored==='staging.hmac.probe'?200:r.status===401?401:0);
    }
    if(statuses[0]===200&&statuses[1]===401) return;
    if(attempt<11) await new Promise(done=>setTimeout(done,1000));
  }
  throw Error('HMAC verification failed; recovery backup retained');
}
export async function productionFingerprint(account, token) {
  const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/mailstack/deployments`,{
    headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000),redirect:'error'});
  const data=await r.json(); if(!r.ok||!data.success) throw Error('Production fingerprint unavailable');
  const canonical=JSON.stringify(data.result,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
  const {createHash}=await import('node:crypto'); return createHash('sha256').update(canonical).digest('hex');
}
