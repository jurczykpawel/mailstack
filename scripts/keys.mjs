import { open as openFile, readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { createMac, open, seal } from '../src/core/crypto/index.ts';
import { keyringFingerprint, parsePrivateKeys } from '../src/core/keyring.ts';

const indexKey = () => ({ kid: crypto.randomUUID(), key: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url') });
const emit = (name, value) => process.stdout.write(`${name}='${JSON.stringify(value)}'\n`);
const publicOf = ({ d, key_ops, ...key }) => key;
const privatePair = async () => {
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  return { ...await crypto.subtle.exportKey('jwk', pair.privateKey), kid: crypto.randomUUID() };
};

async function writePrivate(path) {
  const file = await openFile(path, 'wx', 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(JSON.stringify({ keys: [await privatePair()] }) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
}

async function askForCopy(path) {
  const prompt = process.stdin.isTTY && createInterface({ input: process.stdin, output: process.stderr });
  try { return prompt ? (await prompt.question(`Copy ${path} to offline storage, then enter the path of that copy: `)).trim() : ''; }
  finally { prompt?.close(); }
}

// D3: the copy must be a different file with the same keyring and must open content sealed to every public key.
async function verifyCopy(path, copy) {
  const [original, backup] = await Promise.all([stat(path), stat(copy)]);
  if (original.dev === backup.dev && original.ino === backup.ino) throw new Error();
  const keys = parsePrivateKeys(await readFile(path, 'utf8'));
  const copied = parsePrivateKeys(await readFile(copy, 'utf8'));
  const fingerprint = await keyringFingerprint(keys);
  if (await keyringFingerprint(copied) !== fingerprint) throw new Error();
  const context = { brand: 'backup', messageId: 'verify', purpose: 'content' };
  for (const key of keys) await open(await seal(true, context, [publicOf(key)]), context, copied);
  return { keys, fingerprint };
}

try {
  const args = process.argv.slice(2);
  const flag = args.indexOf('--backup-verified');
  let copy = flag < 0 ? undefined : args.splice(flag, 2)[1];
  if (flag >= 0 && !copy) throw new Error();
  const [command, path, ...extra] = args;
  if (extra.length) throw new Error();
  if (command === 'init' && path) {
    if (!copy) copy = await writePrivate(path).then(() => askForCopy(path));
    if (!copy) {
      process.stderr.write(`Offline copy not verified; no keys were printed. Copy ${path} to offline storage, then run:\n` +
        `npm run --silent keys -- init ${path} --backup-verified <path-of-copy>\n`);
      process.exitCode = 1;
    } else {
      const { keys, fingerprint } = await verifyCopy(path, copy);
      process.stderr.write(`Offline copy verified. Keyring fingerprint: ${fingerprint}\n`);
      emit('CONTENT_PUBLIC_KEYS', { keys: keys.map(publicOf) });
      emit('INDEX_KEYS', [indexKey()]);
      emit('TRANSIT_KEYS', { keys: [await privatePair()] });
    }
  } else if (command === 'rotate-index' && !path && !copy) {
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
