import { readRecords, appendRecord } from './records.mjs';
import { createServer as tcp, connect } from 'node:net';
import { createServer } from 'node:https';
import { createServer as http } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, sign } from 'node:crypto';
const dir = '/run/fixture', records = '/data/records.jsonl';
let modes = { hook: '200', ntfy: '200', license: '200', callback: '200' };
const credentials = JSON.parse(readFileSync(dir + '/credentials.json'));
const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const server = createServer({ key: readFileSync(dir + '/tls.key'), cert: readFileSync(dir + '/tls.crt') }, async (req, res) => {
  const url = new URL(req.url, 'https://fixture'); let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 11 * 1024 * 1024) { req.destroy(); return; } }
  if (url.pathname === '/control' && req.method === 'POST') {
    const input = JSON.parse(body); for (const [k, v] of Object.entries(input)) {
      if (!(k in modes) || !['200', '500', 'timeout', 'redirect'].includes(v)) return json(res, { error: 'Invalid mode' }, 400);
    }
    modes = { ...modes, ...input }; return json(res, modes);
  }
  if (url.pathname === '/records' || url.pathname === '/records/diagnostics') {
    try {
      const history = readRecords(records);
      res.setHeader('x-fixture-discarded-records', String(history.diagnostics.discarded.length));
      res.setHeader('x-fixture-nul-bytes', String(history.diagnostics.nulBytes));
      if (history.diagnostics.original) console.error(JSON.stringify(history.diagnostics));
      return json(res, url.pathname === '/records' ? history.records : history.diagnostics);
    } catch { return json(res, { error: 'History unavailable' }, 503); }
  }
  if (url.pathname === '/health') return json(res, { ok: true, modes });
  const category = url.pathname === '/jwks' || url.pathname === '/crl' ? 'license' : url.pathname === '/ntfy' ? 'ntfy' : url.pathname === '/callback' ? 'callback' : 'hook';
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(req.headers['x-mailstack-signature'] ?? '');
  const secret = category === 'callback' ? credentials.callbackSecret : credentials.webhookSecret;
  const signatureValid = !!match && Math.abs(Date.now() / 1000 - Number(match[1])) <= 300 &&
    createHmac('sha256', secret).update(match[1] + '.' + body).digest('hex') === match[2];
  try { appendRecord(records, { at: Date.now(), path: url.pathname, headers: req.headers, body, signatureValid }); }
  catch { return json(res, { error: 'History unavailable' }, 503); }
  if (modes[category] === 'timeout') { const t = setTimeout(() => res.end(), 12000); res.on('close', () => clearTimeout(t)); return; }
  if (modes[category] === 'redirect') { res.writeHead(302, { location: 'https://hooks.test.example/redirect-target' }); return res.end(); }
  if (modes[category] === '500') return json(res, { error: 'Synthetic failure' }, 500);
  if (url.pathname === '/jwks') return json(res, { keys: [{ kid: 'test-es256', alg: 'ES256', pem: readFileSync(dir + '/license.pub', 'utf8') }] });
  if (url.pathname === '/crl') return json(res, { order_hashes: [createHash('sha256').update('test-revoked').digest('hex')].filter(h => h.startsWith(url.searchParams.get('prefix') ?? '')) });
  if (category === 'callback' && signatureValid) {
    const event = JSON.parse(body);
    const response = await fetch('http://api:8080/v1/send', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + credentials.source, 'Idempotency-Key': event.idempotencyKey },
      body: JSON.stringify({ brand: event.brand, template: 'license', to: 'buyer@acme.example', name: 'Test', productName: 'Test Pro', licenseKey: 'TEST-REISSUED-END4', ref: event.ref, resendOf: event.messageId }) });
    return json(res, { status: response.status, body: await response.json() }, response.ok ? 200 : 500);
  }
  json(res, { ok: true, signatureValid });
});
server.listen(8443, '0.0.0.0');
http((req, res) => {
  if (req.url === '/health') return json(res, { ok: true });
  if (req.url === '/ntfy') { let body=''; req.on('data',c=>body+=c); req.on('end',()=>{ try { appendRecord(records,{at:Date.now(),path:'/ntfy',body}); } catch { return json(res,{error:'History unavailable'},503); } if(modes.ntfy==='timeout'){const t=setTimeout(()=>res.end(),12000);res.on('close',()=>clearTimeout(t));} else if(modes.ntfy==='redirect'){res.writeHead(302,{location:'http://fixture:8082/health'});res.end();} else json(res,{ok:true},Number(modes.ntfy)); }); return; }
  if (req.url === '/sign-sns' && req.method === 'POST') { let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{const b=JSON.parse(raw);const fields=['Message','MessageId',...(Object.hasOwn(b,'Subject')?['Subject']:[]),'Timestamp','TopicArn','Type'];b.Signature=sign('sha256',Buffer.from(fields.map(k=>k+'\n'+b[k]+'\n').join('')),readFileSync(dir+'/tls.key')).toString('base64');json(res,b);});return; }
  if (req.url === '/request' && req.method === 'POST') {
    // Same-origin utility only sends to the isolated API, never to a user-supplied URL.
    let raw = ''; req.on('data', c => raw += c); req.on('end', async () => {
      try { const input = JSON.parse(raw); const r = await fetch('http://api:8080/v1/send', { method: 'POST', headers: { 'content-type': 'application/json', ...(input.client ? { authorization: 'Bearer ' + credentials[input.client] } : {}) }, body: input.body }); json(res, { status: r.status, body: await r.json() }); }
      catch { json(res, { error: 'Request failed' }, 400); }
    }); return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(readFileSync('/app/playground.html','utf8'));
}).listen(8082, '0.0.0.0');

for (const [port, host, target] of [[8080,'api',8080],[8090,'panel',8090],[8025,'mailpit',8025]]) tcp(socket=>{const upstream=connect(target,host);socket.pipe(upstream);upstream.pipe(socket);socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());socket.on('close',()=>upstream.destroy());}).listen(port,'0.0.0.0');
