import { execFileSync } from 'node:child_process';
import { withBackgroundTasks } from './lifecycle.ts';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createSqliteStore } from '../../src/core/store/sqlite.ts';
import { parseKeyring } from '../../src/core/keyring.ts';
import { handleSesEvent } from '../../src/events/ses.ts';
import { createVerifier } from '../../src/events/sns.ts';
import { loadExtensions } from '../../src/runtime/extensions.ts';
import { smtpFromEnv } from '../../src/adapters/sender/smtp.ts';
import { loadNodeConfig } from '../../src/core/config/node.ts';
import { createNtfyNotifier } from '../../src/adapters/notify/ntfy.ts';
const cfg = loadNodeConfig(), tokens = JSON.parse(readFileSync('/run/seed/tokens.json', 'utf8'));
const db = new Database('/data/mailstack.db'), store = createSqliteStore(db);
const command = process.argv[2] ?? 'seed';
const result = await withBackgroundTasks(async waitUntil => {
  const runtime = ['retention','event'].includes(command) ? await loadExtensions(cfg,store,undefined,{sendEmail:smtpFromEnv(process.env),provider:'smtp'}) : undefined;
  if (command === 'retention') { await runtime!.runRetention(Date.now()); }
  else if (command === 'seed-events') {
    const {messages}=JSON.parse(readFileSync('/data/manual-seed.json','utf8'));
    for(const [template,type,recipient] of [['contact','Delivery','buyer@acme.example'],['bounce','Bounce','bounce@acme.example']]) console.log(execFileSync('node',[process.argv[1],'event',messages[template],type,'SEED-'+type,recipient],{encoding:'utf8'}));
  } else if (command === 'expire') {
    db.prepare("UPDATE messages SET meta_expires_at=? WHERE id IN (SELECT id FROM messages WHERE ref_idx IS NOT NULL AND template='received')").run(Date.now()-1);
    db.prepare("UPDATE contents SET expires_at=? WHERE message_id IN (SELECT id FROM messages WHERE template='payment')").run(Date.now()-1);
  } else if (command === 'seed') {
    if (existsSync('/data/manual-seed.json')) { console.log('Seed already present'); }
    else {
      const messages: Record<string,string> = {};
      for (const template of ['contact','payment','license','notice','welcome','received']) {
        const r = await fetch('http://127.0.0.1:8080/v1/send', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tokens[template === 'license' ? 'source' : 'send'], 'Idempotency-Key': 'SEED-' + template },
          body: JSON.stringify({ brand: 'acme', template, to: 'buyer@acme.example', replyTo: 'reply@acme.example', email: 'submitter@acme.example', ref: 'SEED-' + template,
            name: 'Żaneta Łącka', message: 'Wiadomość testowa <script>alert(1)</script>', paragraphs: ['Pierwszy akapit', 'Zażółć gęślą jaźń'],
            amount: '149.00', currency: 'PLN', orderId: 'SEED-149', item: 'Test Pro', invoiceUrl: 'https://acme.example/invoice?token=TEST',
            productName: 'Test Pro', domain: 'acme.example', licenseKey: 'TEST-' + 'X'.repeat(360) + '-END4', activationUrl: 'https://acme.example/activate?key=TEST',
            ctaUrl: 'https://acme.example/test', ctaLabel: 'Zobacz test', summary: 'Potwierdzenie testowe' }) });
        const result = await r.json() as { id?: string }; if (!r.ok) throw new Error('Seed send failed: ' + r.status);
        if (result.id) messages[template] = result.id;
      }
      const r = await fetch('http://127.0.0.1:8080/v1/send', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tokens.send }, body: JSON.stringify({ brand:'demo', template:'notice', to:'other@demo.example', heading:'SEED demo' }) });
      if (!r.ok) throw new Error('Demo seed failed');
      messages.demo = ((await r.json()) as { id:string }).id;
      for(const [label,template,email] of [['bounce','notice','bounce@acme.example'],['expiring-meta','received','expiry@acme.example'],['expiring-content','payment','expiry@acme.example']]) {
        const response=await fetch('http://127.0.0.1:8080/v1/send',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+tokens.send},body:JSON.stringify({brand:'acme',template,to:email,ref:'SEED-'+label,heading:label,amount:'10.00'})});
        if(!response.ok)throw new Error('Additional fixture send failed'); messages[label]=((await response.json()) as {id:string}).id;
      }
      db.prepare('UPDATE messages SET meta_expires_at=? WHERE id=?').run(Date.now()+3600000,messages['expiring-meta']);
      db.prepare('UPDATE contents SET expires_at=? WHERE message_id=?').run(Date.now()+900000,messages['expiring-content']);
      db.prepare('UPDATE replays SET expires_at=? WHERE message_id=?').run(Date.now()+900000,messages['expiring-content']);
      writeFileSync('/data/manual-seed.json', JSON.stringify({ messages, at:Date.now() }), { mode:0o600 });
      console.log(JSON.stringify({ messages }));
    }
  } else if (command === 'event') {
    const messageId = process.argv[3], type = process.argv[4] ?? 'Bounce';
    const recipient = process.argv[6] ?? 'buyer@acme.example';
    const notification = { eventType:type, mail:{ messageId:'fixture-provider', tags:{ ms_id:[messageId] } },
      ...(type === 'Bounce' ? { bounce:{ bounceType:'Permanent', bouncedRecipients:[{emailAddress:recipient,diagnosticCode:'550 test'}] } } :
        type === 'Complaint' ? { complaint:{ complainedRecipients:[{ emailAddress:recipient }] } } : { delivery:{ recipients:[recipient] } }) };
    const envelope: Record<string,string> = { Type:'Notification', Message:JSON.stringify(notification), MessageId:process.argv[5] ?? randomUUID(),
      TopicArn:cfg.events!.ses!.topicArns[0], Timestamp:new Date().toISOString(), SignatureVersion:'2', SigningCertURL:'https://sns.eu-west-1.amazonaws.com/test.pem' };
    const response = await fetch('http://fixture:8082/sign-sns', { method:'POST', body:JSON.stringify(envelope) });
    const signed = await response.json();
    const cert = readFileSync('/run/fixture/tls.crt','utf8');
    const fetcher: typeof fetch = async () => new Response(cert);
    const result = await handleSesEvent(new Request('http://fixture/v1/events/ses', { method:'POST', headers:{'x-amz-sns-message-type':'Notification'}, body:JSON.stringify(signed) }),
      { store, emitEvent:runtime!.emitEvent, waitUntil, ...parseKeyring(process.env), options:cfg.events!.ses, verify:createVerifier(fetcher), now:Date.now, logging:cfg.logging, notifier:createNtfyNotifier({NTFY_URL:process.env.NTFY_URL,NTFY_TOKEN:process.env.NTFY_TOKEN}) });
    return { status: result.status, body: await result.json(), messageId };
  } else throw new Error('Use seed|expire|retention|event MESSAGE_ID [Bounce|Complaint|Delivery] [EVENT_ID]');
}, async () => { await store.db.destroy(); });
if (result) {
  console.log(JSON.stringify({ ...result, background: 'drained', webhookDelivery: 'not_confirmed' }));
  if (result.status !== 200) process.exitCode = 1;
}
