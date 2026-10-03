import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { SafeHttpClient, SourceError, isPublicIp, validatePublicUrl, type PinnedRequest, type TransportResponse } from '../../packages/sources/src/index.js';

function response(status = 200, body: string | Buffer = 'ok', headers: TransportResponse['headers'] = {}): TransportResponse {
  return { status, headers, body: (async function* () { yield Buffer.isBuffer(body) ? body : Buffer.from(body); })() };
}
const publicDns = async () => [{ address: '93.184.216.34', family: 4 as const }];

describe('public address policy', () => {
  it.each([
    '0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1',
    '100.64.0.1', '192.0.0.9', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '240.0.0.1', '255.255.255.255', '::', '::1', 'fe80::1', 'fc00::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:93.184.216.34', '::127.0.0.1',
    '64:ff9b::a00:1', '2002:7f00:1::', '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '2001:db8::1', '3fff::1', 'fe80::1%eth0',
  ])('rejects private/reserved IP %s', address => expect(isPublicIp(address)).toBe(false));
  it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888'])('accepts public IP %s', address => expect(isPublicIp(address)).toBe(true));
  it.each([
    'http://127.1/feed', 'http://2130706433/feed', 'http://0x7f000001/feed', 'http://0177.0.0.1/feed',
    'http://[::ffff:127.0.0.1]/feed', 'http://localhost/feed', 'https://a.local/feed',
    'https://feed.example.com:8080/feed', 'file:///etc/passwd', 'ftp://feed.example.com/file',
    'https://user:password@feed.example.com/feed', 'https://feed.example.com/feed?access_token=secret',
    'https://feed.example.com/feed?api_key=secret', 'https://feed.example.com\\@127.0.0.1/feed',
  ])('rejects unsafe URL %s', url => expect(() => validatePublicUrl(url)).toThrow(SourceError));
  it('normalizes IDN, default ports and fragments', () => {
    expect(validatePublicUrl('HTTPS://FEED.Example.COM:443/feed#part').toString()).toBe('https://feed.example.com/feed');
    expect(validatePublicUrl('https://例子.中国/feed').hostname).toMatch(/^xn--/);
  });
});

describe('SafeHttpClient', () => {
  it('validates DNS once and gives transport exactly that pinned public address', async () => {
    const calls: PinnedRequest[] = [];
    let resolves = 0;
    const client = new SafeHttpClient({ resolver: async () => { resolves++; return resolves === 1 ? publicDns() : [{ address: '127.0.0.1', family: 4 }]; }, transport: async request => { calls.push(request); return response(); } });
    expect((await client.get('https://feed.example.com/rss', { etag: '"v1"', lastModified: 'Tue, 01 Sep 2026 00:00:00 GMT' })).body.toString()).toBe('ok');
    expect(resolves).toBe(1);
    expect(calls[0]?.address.address).toBe('93.184.216.34');
    expect(calls[0]?.url.hostname).toBe('feed.example.com');
    expect(calls[0]?.headers['if-none-match']).toBe('"v1"');
  });
  it('rejects a DNS answer set containing both public and private IPs without connecting', async () => {
    let called = false;
    const client = new SafeHttpClient({ resolver: async () => [...await publicDns(), { address: '169.254.169.254', family: 4 }], transport: async () => { called = true; return response(); } });
    await expect(client.get('https://feed.example.com/rss')).rejects.toMatchObject({ code: 'unsafe_address' });
    expect(called).toBe(false);
  });
  it('rejects mapped IPv6 DNS answers without connecting', async () => {
    const client = new SafeHttpClient({ resolver: async () => [{ address: '::ffff:7f00:1', family: 6 }], transport: async () => response() });
    await expect(client.get('https://feed.example.com/rss')).rejects.toMatchObject({ code: 'unsafe_address' });
  });
  it('revalidates redirected destinations before a second connection', async () => {
    let connects = 0;
    const client = new SafeHttpClient({ resolver: publicDns, transport: async () => { connects++; return response(302, '', { location: 'http://169.254.169.254/latest/meta-data' }); } });
    await expect(client.get('https://feed.example.com/rss')).rejects.toMatchObject({ code: 'unsafe_address' });
    expect(connects).toBe(1);
  });
  it('re-resolves the same hostname at every relative redirect and detects rebinding', async () => {
    let resolves = 0, connects = 0;
    const client = new SafeHttpClient({ resolver: async () => ++resolves === 1 ? publicDns() : [{ address: '127.0.0.1', family: 4 }], transport: async () => { connects++; return response(302, '', { location: '/new-feed' }); } });
    await expect(client.get('https://feed.example.com/rss')).rejects.toMatchObject({ code: 'unsafe_address' });
    expect(resolves).toBe(2); expect(connects).toBe(1);
  });
  it('caps redirects and clears validators across an origin change', async () => {
    const requests: PinnedRequest[] = [];
    const client = new SafeHttpClient({ maxRedirects: 1, resolver: publicDns, transport: async request => { requests.push(request); return response(302, '', { location: 'https://other.example.com/rss' }); } });
    await expect(client.get('https://feed.example.com/rss', { etag: '"secret-validator"' })).rejects.toMatchObject({ code: 'too_many_redirects' });
    expect(requests).toHaveLength(2); expect(requests[1]?.headers['if-none-match']).toBeUndefined();
  });
  it('returns 304 and does not consume a response body', async () => {
    let consumed = false;
    const client = new SafeHttpClient({ resolver: publicDns, transport: async () => ({ status: 304, headers: { ETag: '"v2"' }, body: (async function* () { consumed = true; yield Buffer.from('invalid'); })() }) });
    const result = await client.get('https://feed.example.com/rss', { etag: '"v1"' });
    expect(result.status).toBe(304); expect(result.body.length).toBe(0); expect(result.headers.etag).toBe('"v2"'); expect(consumed).toBe(false);
  });
  it('caps wire bytes even with no content length', async () => {
    const client = new SafeHttpClient({ resolver: publicDns, maxCompressedBytes: 5, transport: async () => response(200, '123456') });
    await expect(client.get('https://feed.example.com/rss')).rejects.toMatchObject({ code: 'body_too_large' });
  });
  it('caps decompressed bytes for gzip bombs', async () => {
    const client = new SafeHttpClient({ resolver: publicDns, maxBodyBytes: 100, transport: async () => response(200, gzipSync('x'.repeat(10_000)), { 'content-encoding': 'gzip' }) });
    await expect(client.get('https://feed.example.com/rss')).rejects.toMatchObject({ code: 'body_too_large' });
  });
  it('rejects unsupported and corrupt compressed encodings', async () => {
    for (const encoding of ['gzip, br', 'compress', 'gzip']) {
      const client = new SafeHttpClient({ resolver: publicDns, transport: async () => response(200, 'bad', { 'content-encoding': encoding }) });
      await expect(client.get('https://feed.example.com/rss')).rejects.toMatchObject({ code: encoding === 'gzip' ? 'invalid_encoding' : 'unsupported_encoding' });
    }
  });
  it('enforces an absolute deadline during a stalled DNS lookup', async () => {
    const client = new SafeHttpClient({ timeoutMs: 15, resolver: () => new Promise(() => undefined), transport: async () => response() });
    await expect(client.get('https://feed.example.com/rss')).rejects.toMatchObject({ code: 'timeout' });
  });
  it('enforces a deadline during a stalled body and closes the transport', async () => {
    let closed = false;
    const client = new SafeHttpClient({ timeoutMs: 15, resolver: publicDns, transport: async () => ({ status: 200, headers: {}, close: () => { closed = true; }, body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }) } }) });
    await expect(client.get('https://feed.example.com/rss')).rejects.toMatchObject({ code: 'timeout' }); expect(closed).toBe(true);
  });
  it('limits requests per hostname and releases capacity after completion', async () => {
    let finish: (() => void) | undefined;
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const client = new SafeHttpClient({ resolver: publicDns, maxConcurrentPerHost: 1, transport: async () => { await wait; return response(); } });
    const first = client.get('https://feed.example.com/one');
    await expect(client.get('https://feed.example.com/two')).rejects.toMatchObject({ code: 'network_limit' });
    finish!(); await first;
    await expect(client.get('https://feed.example.com/three')).resolves.toMatchObject({ status: 200 });
  });
});
