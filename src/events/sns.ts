import type { Config } from '../core/config/schema';

export type SesOptions = NonNullable<NonNullable<Config['events']>['ses']>;
export type Envelope = Record<string, string>;
const types = ['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation'];
export function envelope(value: unknown, header: string | null): value is Envelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const b = value as Envelope;
  const fields = ['Type', 'Message', 'MessageId', 'TopicArn', 'Timestamp', 'SignatureVersion', 'Signature', 'SigningCertURL'];
  if (b.Type !== 'Notification') fields.push('SubscribeURL', 'Token');
  return types.includes(b.Type) && header === b.Type && fields.every(k => typeof b[k] === 'string' && b[k].length > 0)
    && (!Object.hasOwn(b, 'Subject') || typeof b.Subject === 'string');
}
export async function boundedText(input: Request | Response, limit: number): Promise<string> {
  if (Number(input.headers.get('content-length')) > limit) throw new RangeError();
  const reader = input.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new RangeError(); }
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}
function awsUrl(value: string, topic: string, certificate: boolean): URL {
  const url = new URL(value);
  const region = topic.split(':')[3];
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
    !/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname) || url.hostname !== `sns.${region}.amazonaws.com` ||
    (certificate ? !url.pathname.endsWith('.pem') : url.searchParams.get('TopicArn') !== topic)) throw new Error();
  return url;
}
function spki(pem: string): ArrayBuffer {
  const match = /^\s*-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----\s*$/.exec(pem);
  if (!match) throw new Error();
  const bytes = Uint8Array.from(atob(match[1].replace(/\s/g, '')), c => c.charCodeAt(0));
  function item(start: number, limit: number) {
    let pos = start + 1, size = bytes[pos++];
    if (size & 128) {
      const count = size & 127;
      if (!count || count > 4) throw new Error();
      size = 0;
      for (let i = 0; i < count; i++) size = size * 256 + bytes[pos++];
    }
    if (!Number.isSafeInteger(size) || pos + size > limit || pos > limit) throw new Error();
    return { tag: bytes[start], start, content: pos, end: pos + size };
  }
  const cert = item(0, bytes.length);
  if (cert.tag !== 48 || cert.end !== bytes.length) throw new Error();
  const tbs = item(cert.content, cert.end);
  if (tbs.tag !== 48) throw new Error();
  let pos = tbs.content;
  if (bytes[pos] === 160) pos = item(pos, tbs.end).end;
  for (let i = 0; i < 5; i++) pos = item(pos, tbs.end).end;
  const key = item(pos, tbs.end);
  if (key.tag !== 48) throw new Error();
  return bytes.slice(key.start, key.end).buffer;
}
export function createVerifier(fetcher: typeof fetch = fetch, now: () => number = Date.now) {
  const cache = new Map<string, { pem: string; expires: number }>();
  return async (b: Envelope, header: string | null, options: SesOptions): Promise<boolean> => {
    try {
      if (!envelope(b, header) || !options.topicArns.includes(b.TopicArn) ||
        !options.accountIds.includes(b.TopicArn.split(':')[4]) ||
        !(b.SignatureVersion === '2' || (b.SignatureVersion === '1' && options.allowSignatureV1))) return false;
      const url = awsUrl(b.SigningCertURL, b.TopicArn, true);
      if (!Number.isFinite(Date.parse(b.Timestamp))) return false;
      if (b.Type === 'SubscriptionConfirmation') {
        if (Math.abs(now() - Date.parse(b.Timestamp)) > 3600000) return false;
        awsUrl(b.SubscribeURL, b.TopicArn, false);
      }
      let entry = cache.get(url.href);
      if (!entry || entry.expires <= now()) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
          const response = await fetcher(url.href, { redirect: 'error', signal: controller.signal });
          if (!response.ok) { await response.body?.cancel(); return false; }
          entry = { pem: await boundedText(response, 65536), expires: now() + 86400000 };
          spki(entry.pem);
          for (const [key, value] of cache) if (value.expires <= now()) cache.delete(key);
          if (cache.size >= 64) cache.delete(cache.keys().next().value!);
          cache.set(url.href, entry);
        } finally { clearTimeout(timer); }
      }
      const fields = b.Type === 'Notification' ? ['Message', 'MessageId', ...(Object.hasOwn(b, 'Subject') ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type']
        : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
      const key = await crypto.subtle.importKey('spki', spki(entry.pem), { name: 'RSASSA-PKCS1-v1_5', hash: b.SignatureVersion === '2' ? 'SHA-256' : 'SHA-1' }, false, ['verify']);
      return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, Uint8Array.from(atob(b.Signature), c => c.charCodeAt(0)),
        new TextEncoder().encode(fields.map(k => `${k}\n${b[k]}\n`).join('')));
    } catch { return false; }
  };
}
export async function confirm(b: Envelope, fetcher: typeof fetch): Promise<void> {
  const url = awsUrl(b.SubscribeURL, b.TopicArn, false);
  const response = await fetcher(url.href, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000) });
  await response.body?.cancel();
  if (!response.ok) throw new Error();
}
