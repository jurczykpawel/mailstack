// An in-memory S3 bucket behind `fetch` (PUT, GET, ListObjectsV2 in pages), for code that talks to B2 through aws4fetch.
import { vi } from 'vitest';

export const b2Env = { B2_ENDPOINT: 'https://s3.eu-central-003.backblazeb2.com', B2_BUCKET: 'mailstack-test', B2_KEY_ID: 'key', B2_APP_KEY: 'secret', TOMBSTONE_REGISTRY_ID: 'test-register-0001' };

export function fakeB2({ page = 1000 } = {}) {
  const objects = new Map<string, Uint8Array>(), b2 = { objects, down: false, puts: 0 };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    // Like workerd, which rejects `redirect: 'error'` outright.
    if (init?.redirect === 'error' || (input instanceof Request && input.redirect === 'error')) throw new TypeError('Invalid redirect value');
    const req = new Request(input, init), url = new URL(req.url), [, bucket, ...rest] = url.pathname.split('/'), key = decodeURIComponent(rest.join('/'));
    if (url.origin !== b2Env.B2_ENDPOINT || bucket !== b2Env.B2_BUCKET || !req.headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256')) return new Response(null, { status: 403 });
    if (b2.down) return new Response(null, { status: 503 });
    if (req.method === 'PUT') { b2.puts++; objects.set(key, new Uint8Array(await req.arrayBuffer())); return new Response(null, { status: 200 }); }
    if (key) return objects.has(key) ? new Response(objects.get(key)) : new Response(null, { status: 404 });
    const prefix = url.searchParams.get('prefix') ?? '', after = url.searchParams.get('continuation-token') ?? '';
    const keys = [...objects.keys()].filter(k => k.startsWith(prefix) && k > after).sort(), shown = keys.slice(0, page), more = keys.length > page;
    return new Response(`<?xml version="1.0"?><ListBucketResult>${shown.map(k => `<Contents><Key>${k}</Key></Contents>`).join('')}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${shown.at(-1)}</NextContinuationToken>` : ''}</ListBucketResult>`);
  });
  return b2;
}
