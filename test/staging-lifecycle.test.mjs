import assert from 'node:assert/strict';
import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import vm from 'node:vm';

it('shares the staging application and isolates delivery outcomes across entrypoints', async () => {
// Execute the actual generated entry with a spy app and an asynchronous sender.
const script = readFileSync('scripts/staging/worker.mjs', 'utf8');
const start = script.indexOf('const contents = ') + 'const contents = '.length;
const literal = script.slice(start, script.indexOf(';\n  await build({ stdin: { contents', start));
const entry = new Function('resolve', 'root', 'egress', 'fixture', 'delivery', 'limits', 'sesFrom', `return ${literal}`)(resolve, '/staging', false, {}, 'ses', {day:50,hour:10}, 'no-reply@staging.example.com');
let constructions = 0, scheduled = 0;
const seen = [];
const context = vm.createContext({
  AsyncLocalStorage, Response, Request, Headers, URL, setTimeout,
  WorkerEntrypoint: class {},
  receiver: () => async () => undefined, receiverCleanup: async () => {},
  sendEmail: async (env) => {
    await new Promise(done => setTimeout(done, env.delay));
    return env.reason ? {ok:false,status:503,response:env.reason} : {ok:true};
  },
  budgetSender: (_query, sender) => sender,
  budgetResponse: (r, reason) => reason ? Response.json({reason},{status:429}) : r,
  createApp: ({sendEmail}) => {
    constructions++;
    const fetch = async (req, env) => { seen.push(new URL(req.url).pathname); const result=await sendEmail(env,{}); return new Response(null,{status:result.ok?200:502}); };
    return { fetch, internal: fetch, scheduled: async (_event,env) => {scheduled++; assert.equal((await sendEmail(env,{})).response,'staging_delivery_disabled');} };
  },
});
vm.runInContext(entry.replace(/^import .*;\n/gm,'').replace('export default ', 'globalThis.worker = ').replace('export class Internal','globalThis.Internal = class Internal'), context);
const ctx={waitUntil:()=>{}};
const request=path=>new Request('https://staging.example'+path);
const [denied,accepted]=await Promise.all([
  context.worker.fetch(request('/denied'),{delay:1,reason:'staging_ses_limit'},ctx),
  context.worker.fetch(request('/accepted'),{delay:20},ctx),
]);
assert.equal(denied.status,429);assert.equal(accepted.status,200);
const bound=new context.Internal();bound.env={delay:1};bound.ctx=ctx;
assert.equal((await bound.fetch(request('/internal'))).status,200);
await context.worker.scheduled({}, {}, ctx);
assert.equal(constructions,1);assert.equal(scheduled,1);assert.deepEqual(seen,['/denied','/accepted','/internal']);
assert.match(readFileSync('src/index.ts','utf8'),/export default createApp\(\);/);
});
