export interface AltchaChallenge {
  algorithm: 'SHA-256';
  challenge: string;
  salt: string;
  signature: string;
  maxnumber: number;
}

const enc = new TextEncoder();
const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

/** Build an Altcha challenge: number is the secret PoW answer; signature binds it to our key. */
export async function createChallenge(hmacKey: string, opts?: { maxnumber?: number }): Promise<AltchaChallenge> {
  const maxnumber = opts?.maxnumber ?? 100_000;
  const saltBytes = crypto.getRandomValues(new Uint8Array(12));
  const salt = toHex(saltBytes.buffer);
  const number = crypto.getRandomValues(new Uint32Array(1))[0] % (maxnumber + 1);
  const challenge = await sha256Hex(salt + number);
  const signature = await hmacHex(hmacKey, challenge);
  return { algorithm: 'SHA-256', challenge, salt, signature, maxnumber };
}

/** Verify a base64 widget payload: recompute hash from salt+number and the signature from our key. Fail-closed. */
export async function verifyAltcha(hmacKey: string, payloadB64: string): Promise<boolean> {
  try {
    const p = JSON.parse(atob(payloadB64)) as {
      algorithm?: string; challenge?: string; salt?: string; number?: number; signature?: string;
    };
    if (p.algorithm !== 'SHA-256' || !p.challenge || !p.salt || typeof p.number !== 'number' || !p.signature) {
      return false;
    }
    const expectedChallenge = await sha256Hex(p.salt + p.number);
    if (expectedChallenge !== p.challenge) return false;
    const expectedSig = await hmacHex(hmacKey, p.challenge);
    return expectedSig === p.signature;
  } catch {
    return false;
  }
}
