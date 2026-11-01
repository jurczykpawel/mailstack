import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changeHmac } from '../scripts/staging/hmac.mjs';
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, {recursive:true,force:true}); });
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
