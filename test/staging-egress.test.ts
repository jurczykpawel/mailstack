import { describe, expect, it } from 'vitest';
// Gate E5 (A 3.6) on the real path Worker -> Tunnel -> egress service: MAILSTACK_STAGING_EGRESS_URL=https://<staging Worker host>,
// MAILSTACK_STAGING_EGRESS_KEY=<STAGING_RECEIVER_KEY>, MAILSTACK_STAGING_DENIED=<comma list: a host in the egress zone and the
// egress host's public addresses>; optional MAILSTACK_STAGING_MIXED_HOST resolving to public and private addresses.
const base = process.env.MAILSTACK_STAGING_EGRESS_URL, key = process.env.MAILSTACK_STAGING_EGRESS_KEY, mixed = process.env.MAILSTACK_STAGING_MIXED_HOST;
const denied = (process.env.MAILSTACK_STAGING_DENIED ?? '').split(',').filter(Boolean);
type Probe = { ready: boolean; readyMs: number; postMs: number; result?: { status: number; bytes: number }; error?: string };
const probe = async (url: string, ms = 10000): Promise<Probe> => (await fetch(`${base}/_staging/egress`,
  { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ url, ms }) })).json() as Promise<Probe>;
describe.skipIf(!base || !key)('egress service on staging (gate E5)', () => {
  it('records the cold start, then refuses private targets before connecting', async () => {
    const first = await probe('https://10.0.0.1/');
    console.log('egress ready ms', first.readyMs, 'post ms', first.postMs);
    for (const url of ['https://10.0.0.1/', 'https://[::ffff:10.0.0.1]/', 'https://169.254.169.254/', 'https://100.100.100.100/', 'https://localtest.me/',
      ...denied.map(host => `https://${host.includes(':') ? `[${host}]` : host}/`), ...mixed ? [`https://${mixed}/`] : []])
      expect((await probe(url)).error, url).toBe('Invalid webhook address');
  }, 60000);
  it('never reaches the private answer of a rebinding name', async () => {
    for (let i = 0; i < 6; i++) expect((await probe('https://7f000001.01010101.rbndr.us/')).result).toBeUndefined();
  }, 120000);
  it('does not follow redirects, rejects bad certificates and stops at the deadline', async () => {
    expect((await probe(`${base}/_staging/redirect`)).result?.status).toBe(302);
    for (const host of ['expired', 'self-signed', 'wrong.host']) expect((await probe(`https://${host}.badssl.com/`)).result, host).toBeUndefined();
    expect((await probe(`${base}/_staging/slow`, 3000)).error).toBe('Egress timeout');
  }, 60000);
  it('counts responses without content-length, delivers to Cloudflare and own-zone targets', async () => {
    expect((await probe(`${base}/_staging/stream?n=10`)).result).toEqual({ status: 200, bytes: 10 });
    expect((await probe(`${base}/_staging/stream?n=70000`)).error).toBe('Egress response limit');
    const cloudflare = await probe('https://www.cloudflare.com/');
    console.log('egress post ms (public target)', cloudflare.postMs);
    expect(cloudflare.result?.status).toBeGreaterThan(0);
  }, 60000);
});
