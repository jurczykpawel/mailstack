import { open } from 'node:fs/promises';
import { createMac } from '../src/core/crypto/index.ts';

const indexKey = () => ({ kid: crypto.randomUUID(), key: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url') });
const emit = (name, value) => process.stdout.write(`${name}='${JSON.stringify(value)}'\n`);

try {
  const [command, path, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error();
  if (command === 'init' && path) {
    const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    const kid = crypto.randomUUID();
    const publicKey = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid };
    const privateKey = { ...await crypto.subtle.exportKey('jwk', pair.privateKey), kid };
    const file = await open(path, 'wx', 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(JSON.stringify({ keys: [privateKey] }) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    emit('CONTENT_PUBLIC_KEYS', { keys: [publicKey] });
    emit('INDEX_KEYS', [indexKey()]);
  } else if (command === 'rotate-index' && !path) {
    const keys = JSON.parse(process.env.INDEX_KEYS || '[]');
    if (!Array.isArray(keys)) throw new Error();
    for (const key of keys) {
      if (!key || Object.keys(key).sort().join(',') !== 'key,kid') throw new Error();
      await createMac(null, [key]);
    }
    const rotated = [indexKey(), ...keys];
    await createMac(null, rotated);
    emit('INDEX_KEYS', rotated);
  } else {
    throw new Error();
  }
} catch {
  process.stderr.write('Unable to manage keys\n');
  process.exitCode = 1;
}
