import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { changeHmac, verifyHmac } from '../scripts/staging/hmac.mjs';
const dirs = [];
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, {recursive:true,force:true}); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'staging-hmac-')); dirs.push(dir);
  let value = 'original', fingerprint = 'production';
  const apply = vi.fn(async next => { value = next; });
  const verify = vi.fn(async (active, inactive) => { expect(value).toBe(active); expect(active).not.toBe(inactive); });
  const options = { dir, identity:'worker:staging', read:async()=>value, apply, verify, fingerprint:async()=>fingerprint };
  return {dir, options, changeFingerprint:()=>{fingerprint='changed';}, value:()=>value};
}
it('preserves the original before applying and restores after an interrupted swap', async () => {
  const s=setup();
  s.options.verify.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('propagation'));
  await expect(changeHmac('hmac-swap', 'temporary', s.options)).rejects.toThrow('propagation');
  expect(s.value()).toBe('temporary');
  expect(JSON.parse(readFileSync(join(s.dir,'hmac-backup.json'))).original).toBe('original');
  await expect(changeHmac('hmac-swap','other',s.options)).rejects.toThrow();
  await changeHmac('hmac-restore',undefined,s.options);
  expect(s.value()).toBe('original');
  expect(existsSync(join(s.dir,'hmac-backup.json'))).toBe(false);
  expect(s.options.verify).toHaveBeenLastCalledWith('original','temporary');
});
it('retains recovery material and stops when the production fingerprint changes', async () => {
  const s=setup();
  s.options.apply.mockImplementationOnce(async()=>s.changeFingerprint());
  await expect(changeHmac('hmac-swap','temporary',s.options)).rejects.toThrow('Production fingerprint');
  expect(existsSync(join(s.dir,'hmac-backup.json'))).toBe(true);
});
it('refuses another installation and concurrent operators', async () => {
  const s=setup(); await changeHmac('hmac-swap','temporary',s.options);
  await expect(changeHmac('hmac-restore',undefined,{...s.options,identity:'node:staging'})).rejects.toThrow('identity');
  expect(s.options.apply).toHaveBeenCalledTimes(1);
  let release;
  s.options.verify.mockImplementationOnce(()=>new Promise(done=>{release=done;}));
  const restore=changeHmac('hmac-restore',undefined,s.options);
  while(!release) await new Promise(done=>setImmediate(done));
  await expect(changeHmac('hmac-restore',undefined,s.options)).rejects.toThrow();
  release(); await restore;
});

function probeResponse(secret, options) {
  const signature = options.headers['X-Sellf-Signature'];
  const timestamp = signature.match(/t=(\d+)/)[1];
  const expected = createHmac('sha256', secret).update(`${timestamp}.${options.body}`).digest('hex');
  return signature.endsWith(expected)
    ? Response.json({success:true, ignored:'staging.hmac.probe'})
    : Response.json({success:false}, {status:401});
}
for (const command of ['hmac-swap', 'hmac-restore']) {
  for (const failedProbe of [0, 1]) {
    for (const failure of ['connection', 'gateway HTML', 'invalid JSON']) {
      it(`${command} retries ${failure} on probe ${failedProbe} before verifying both signatures`, async () => {
        vi.useFakeTimers();
        const s = setup();
        if (command === 'hmac-restore') await changeHmac('hmac-swap', 'temporary', s.options);
        let applied = false, remaining = 2;
        const fetch = vi.fn(async (_url, options) => {
          const response = probeResponse(s.value(), options);
          const probe = response.status === 200 ? 0 : 1;
          if (applied && probe === failedProbe && remaining-- > 0) {
            if (failure === 'connection') throw new TypeError('Connection refused');
            return new Response('<html>Starting</html>', {status:failure === 'gateway HTML' ? 502 : 200});
          }
          return response;
        });
        vi.stubGlobal('fetch', fetch);
        const apply = s.options.apply;
        const result = changeHmac(command, command === 'hmac-swap' ? 'temporary' : undefined, {
          ...s.options,
          apply:async value => { await apply(value); applied = true; },
          verify:(active, inactive) => verifyHmac('https://staging.example', 'hook', active, inactive),
        });
        const assertion = expect(result).resolves.toBeUndefined();
        await Promise.all([assertion, vi.runAllTimersAsync()]);
        expect(remaining).toBeLessThanOrEqual(0);
        expect(s.value()).toBe(command === 'hmac-swap' ? 'temporary' : 'original');
        expect(existsSync(join(s.dir, 'hmac-backup.json'))).toBe(command === 'hmac-swap');
        const calls = fetch.mock.calls;
        expect(probeResponse(s.value(), calls.at(-2)[1]).status).toBe(200);
        expect(probeResponse(s.value(), calls.at(-1)[1]).status).toBe(401);
      });
    }
  }
  it(`${command} exhausts twelve startup attempts and preserves recovery material`, async () => {
    vi.useFakeTimers();
    const s = setup();
    if (command === 'hmac-restore') await changeHmac('hmac-swap', 'temporary', s.options);
    let applied = false, attempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      if (applied) { attempts++; throw new TypeError('Connection refused'); }
      return probeResponse(s.value(), options);
    }));
    const apply = s.options.apply;
    const result = changeHmac(command, command === 'hmac-swap' ? 'temporary' : undefined, {
      ...s.options,
      apply:async value => { await apply(value); applied = true; },
      verify:(active, inactive) => verifyHmac('https://staging.example', 'hook', active, inactive),
    });
    const assertion = expect(result).rejects.toThrow('HMAC verification failed; recovery backup retained');
    await Promise.all([assertion, vi.runAllTimersAsync()]);
    expect(attempts).toBe(12);
    expect(JSON.parse(readFileSync(join(s.dir, 'hmac-backup.json'), 'utf8'))).toMatchObject({original:'original', temporary:'temporary'});
    expect(existsSync(join(s.dir, 'hmac.lock'))).toBe(false);
  });
}
