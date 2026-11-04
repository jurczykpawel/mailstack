import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { b2Client, tombstoneRegistry } from '../src/core/offsite';
it.each(['put', 'list', 'get'] as const)('finishes %s within the erasure step deadline', async action => {
  const server = createServer((req, res) => {
    req.resume();
    const finish = () => res.end(action === 'list' ? '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>' : 'body');
    let timer: ReturnType<typeof setTimeout>;
    if (action === 'get') { res.writeHead(200); res.write('partial'); timer = setTimeout(finish, 6000); }
    else timer = setTimeout(() => { res.writeHead(200); finish(); }, 6000);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  const b2 = b2Client({ B2_ENDPOINT: `http://127.0.0.1:${address.port}`, B2_BUCKET: 'demo', B2_KEY_ID: 'demo', B2_APP_KEY: 'demo' });
  try {
    const pending = action === 'put' ? b2.put('entry', new Uint8Array([1])) : action === 'list' ? b2.list('register/') : b2.get('entry');
    const start = Date.now();
    await expect(pending).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(5500);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 8000);
it('requires an explicit mode when the erasure register is absent', () => {
  expect(() => tombstoneRegistry({})).toThrow();
});
