import { describe, expect, it } from 'vitest';
import { decodeDocument, discoverFeed, exportOpml, fetchFeed, normalizeText, parseFeed, parseOpml, SafeHttpClient, type HttpResponse } from '../../packages/sources/src/index.js';

const url = 'https://feed.example.com/rss';
const rss = `<rss version="2.0"><channel><title>Example &amp; News</title><link>https://example.com/</link><item><guid isPermaLink="false">post-1</guid><title>A &amp; B</title><link>/article/1#comment</link><description><![CDATA[<p>Hello <b>world</b></p><script>bad()</script>]]></description><pubDate>Tue, 01 Sep 2026 00:00:00 GMT</pubDate></item></channel></rss>`;
function result(body: string, status = 200, headers: Record<string, string> = {}, finalUrl = url): HttpResponse { return { body: Buffer.from(body), status, headers, url: finalUrl }; }

describe('feed normalization', () => {
  it('normalizes RSS, relative links, text, entities and dates', () => {
    const feed = parseFeed(rss, url);
    expect(feed.title).toBe('Example & News');
    expect(feed.items[0]).toMatchObject({ title: 'A & B', summary: 'Hello world', externalId: 'post-1', url: 'https://feed.example.com/article/1', publishedAt: '2026-09-01T00:00:00.000Z' });
    expect(feed.items[0]?.identityCandidates).toContain('external:post-1');
  });
  it('preserves an external identity when content changes and changes the content hash', () => {
    const first = parseFeed(rss, url).items[0]!;
    const second = parseFeed(rss.replace('Hello', 'Changed'), url).items[0]!;
    expect(first.identityCandidates[0]).toBe(second.identityCandidates[0]);
    expect(first.contentHash).not.toBe(second.contentHash);
    expect(parseFeed(rss.replace('Tue, 01 Sep 2026', 'Wed, 02 Sep 2026'), url).items[0]?.contentHash).toBe(first.contentHash);
  });
  it('uses a deterministic content identity when GUID and URL are missing', () => {
    const input = '<rss><channel><title>Feed</title><item><title>Post</title><description>Text</description></item></channel></rss>';
    const a = parseFeed(input, url).items[0]!, b = parseFeed(input, url).items[0]!;
    expect(a.identityCandidates).toEqual([`content:${a.contentHash}`]); expect(a).toEqual(b);
  });
  it('normalizes Atom links, xml:base and XHTML content', () => {
    const input = `<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://blog.example.com/"><title>Atom</title><link href="/"/><entry xml:base="posts/"><id>tag:example.com,2026:1</id><title>One</title><link rel="self" href="entry.xml"/><link rel="alternate" href="one"/><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Some <b>text</b></p></div></content><published>2026-09-01T08:00:00+08:00</published><updated>2026-09-02T00:00:00Z</updated></entry></feed>`;
    expect(parseFeed(input, url).items[0]).toMatchObject({ url: 'https://blog.example.com/posts/one', summary: 'Some text', externalId: 'tag:example.com,2026:1', publishedAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' });
  });
  it('rejects DTD and XXE documents before parsing', () => {
    for (const input of ['<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><title>&x;</title></channel></rss>', '<!DOCTYPE rss [<!ENTITY a "aaaaaaaa">]><rss><channel><title>&a;</title></channel></rss>', '<rss><channel><title>&undeclared;</title></channel></rss>']) {
      expect(() => parseFeed(input, url)).toThrowError(expect.objectContaining({ code: 'unsafe_xml' }));
    }
  });
  it('rejects malformed XML and non-feed XML', () => {
    expect(() => parseFeed('<rss><channel></rss>', url)).toThrowError(expect.objectContaining({ code: 'invalid_xml' }));
    expect(() => parseFeed('<document>hello</document>', url)).toThrowError(expect.objectContaining({ code: 'not_a_feed' }));
  });
  it('drops dangerous article links and ignores invalid dates', () => {
    const feed = parseFeed('<rss><channel><item><title>X</title><link>http://127.0.0.1/private</link><pubDate>invalid</pubDate></item></channel></rss>', url);
    expect(feed.items[0]?.url).toBeUndefined(); expect(feed.items[0]?.publishedAt).toBeUndefined();
  });
  it('decodes declared Windows-1252 and UTF-16 BOM encodings', () => {
    const input = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="windows-1252"?><rss><channel><title>Caf'), Buffer.from([0xe9]), Buffer.from('</title></channel></rss>')]);
    expect(parseFeed(decodeDocument(input), url).title).toBe('Café');
    expect(parseFeed(decodeDocument(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(rss, 'utf16le')])), url).title).toBe('Example & News');
    expect(() => decodeDocument(Buffer.from([0xff, 0x00]))).toThrowError(expect.objectContaining({ code: 'invalid_encoding' }));
  });
  it('removes escaped HTML and control characters', () => expect(normalizeText('&lt;p&gt;Text&nbsp;here&lt;/p&gt;\u0000')).toBe('Text here'));
  it('handles unclosed script markup without retaining script text', () => {
    expect(normalizeText('Visible<script>' + '<script>'.repeat(20_000) + 'hidden')).toBe('Visible');
    expect(normalizeText('Text ' + '<'.repeat(20_000))).toHaveLength(20_000);
  });
  it('rejects excessively nested XML and oversized documents', () => {
    expect(() => parseFeed('<rss><channel>' + '<x>'.repeat(65) + '</x>'.repeat(65) + '</channel></rss>', url)).toThrowError(expect.objectContaining({ code: 'invalid_xml' }));
    expect(() => parseFeed('x'.repeat(4 * 1024 * 1024 + 1), url)).toThrowError(expect.objectContaining({ code: 'body_too_large' }));
  });
});

describe('fetching and discovery', () => {
  it('returns not_modified with preserved and refreshed validators', async () => {
    const client = { get: async () => result('', 304, { etag: '"v2"' }) };
    expect(await fetchFeed(url, { etag: '"v1"', lastModified: 'yesterday' }, client)).toEqual({ kind: 'not_modified', url, etag: '"v2"', lastModified: 'yesterday' });
    await expect(fetchFeed(url, {}, client)).rejects.toMatchObject({ code: 'http_error' });
  });
  it('uses bounded alternate discovery through the same safe client', async () => {
    const paths: string[] = [];
    const client = { get: async (requestUrl: string) => { paths.push(requestUrl); return requestUrl.endsWith('/page') ? result('<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>', 200, { 'content-type': 'text/html' }, requestUrl) : result(rss, 200, { etag: '"version"' }, requestUrl); } };
    const feed = await discoverFeed('https://feed.example.com/page', client);
    expect(feed.url).toBe('https://feed.example.com/feed.xml'); expect(feed.etag).toBe('"version"'); expect(paths).toHaveLength(2);
  });
  it('does not fetch unsafe discovered URLs', async () => {
    let connects = 0;
    const client = new SafeHttpClient({ resolver: async () => [{ address: '93.184.216.34', family: 4 }], transport: async () => { connects++; return { status: 200, headers: { 'content-type': 'text/html' }, body: (async function* () { yield Buffer.from('<html><link rel="alternate" type="application/rss+xml" href="http://127.0.0.1/secret"></html>'); })() }; } });
    await expect(discoverFeed('https://feed.example.com/page', client)).rejects.toMatchObject({ code: 'feed_not_found' }); expect(connects).toBe(1);
  });
  it('reports pages without advertised feeds and HTTP failures', async () => {
    await expect(discoverFeed(url, { get: async () => result('<html><h1>Hello</h1></html>', 200, { 'content-type': 'text/html' }) })).rejects.toMatchObject({ code: 'feed_not_found' });
    await expect(fetchFeed(url, {}, { get: async () => result('error', 503) })).rejects.toMatchObject({ code: 'http_error', status: 503 });
  });
});

describe('OPML', () => {
  it('imports nested folders, deduplicates URLs and round trips escaped text safely', () => {
    const input = '<opml version="2.0"><head><title>Reading</title></head><body><outline text="Folder"><outline type="rss" text="A &amp; B" xmlUrl="https://feed.example.com/rss?a=1&amp;b=2"/></outline><outline xmlUrl="https://feed.example.com/rss?a=1&amp;b=2"/></body></opml>';
    const imported = parseOpml(input);
    expect(imported.feeds).toEqual([{ title: 'A & B', url: 'https://feed.example.com/rss?a=1&b=2' }]);
    expect(parseOpml(exportOpml(imported.feeds, imported.title))).toEqual(imported);
  });
  it('rejects unsafe source URLs, malformed XML and entity declarations', () => {
    expect(() => parseOpml('<opml><body><outline xmlUrl="http://169.254.169.254/rss"/></body></opml>')).toThrowError(expect.objectContaining({ code: 'unsafe_address' }));
    expect(() => parseOpml('<opml><body></opml>')).toThrowError(expect.objectContaining({ code: 'invalid_xml' }));
    expect(() => parseOpml('<!DOCTYPE opml><opml><body/></opml>')).toThrowError(expect.objectContaining({ code: 'unsafe_xml' }));
  });
});
