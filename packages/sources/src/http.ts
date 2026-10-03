import { lookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { promisify } from 'node:util';
import { brotliDecompress, gunzip, inflate } from 'node:zlib';
import ipaddr from 'ipaddr.js';
import { SourceError } from './errors.js';

export interface Validators { etag?: string; lastModified?: string }
export interface HttpResponse { status: number; body: Buffer; headers: Record<string, string>; url: string }
export interface ResolvedAddress { address: string; family: 4 | 6 }
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;
export interface PinnedRequest {
  url: URL;
  address: ResolvedAddress;
  headers: Record<string, string>;
  signal: AbortSignal;
}
export interface TransportResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  close?: () => void;
}
/** Injection is for trusted server configuration/tests, never user input. */
export type RequestTransport = (request: PinnedRequest) => Promise<TransportResponse>;
export interface SafeHttpOptions {
  resolver?: Resolver;
  transport?: RequestTransport;
  timeoutMs?: number;
  maxCompressedBytes?: number;
  maxBodyBytes?: number;
  maxRedirects?: number;
  maxConcurrent?: number;
  maxConcurrentPerHost?: number;
}

const sensitiveQuery = /^(?:access_token|refresh_token|token|key|api[_-]?key|auth(?:orization)?|password|passwd|secret|signature|x-amz-.+|x-goog-.+)$/i;
const localName = /(?:^|\.)(?:localhost|local|internal|lan|home|invalid|test)$/i;
const MAX_URL = 4096;

/** Conservative public IP policy: special-purpose and transition networks are denied. */
export function isPublicIp(address: string): boolean {
  try {
    if (address.includes('%')) return false;
    const ip = ipaddr.parse(address);
    if (ip.kind() === 'ipv4') return ip.range() === 'unicast' && !ip.match(ipaddr.parse('192.0.0.0'), 24);
    const v6 = ip as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress() || v6.range() !== 'unicast') return false;
    if (!v6.match(ipaddr.parse('2000::'), 3)) return false;
    return ![
      ['2001::', 23], // IETF protocol assignments, including Teredo and benchmarking.
      ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], // documentation / 6to4.
    ].some(([network, bits]) => v6.match(ipaddr.parse(network as string), bits as number));
  } catch { return false; }
}

/** Syntactic validation also applies to item links and OPML, without initiating DNS. */
export function validatePublicUrl(value: string, base?: string): URL {
  if (!value || value.length > MAX_URL || /[\u0000-\u0020\u007f\\]/.test(value)) {
    throw new SourceError('invalid_url', 'Enter a valid HTTP or HTTPS URL.');
  }
  let url: URL;
  try { url = base ? new URL(value, base) : new URL(value); }
  catch { throw new SourceError('invalid_url', 'Enter a valid HTTP or HTTPS URL.'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SourceError('invalid_url', 'Only HTTP and HTTPS URLs are supported.');
  if (url.username || url.password || [...url.searchParams.keys()].some(key => sensitiveQuery.test(key))) {
    throw new SourceError('credentials_not_allowed', 'Authenticated or secret feed URLs cannot be shared as public sources.');
  }
  if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) throw new SourceError('invalid_url', 'Only standard HTTP and HTTPS ports are allowed.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname || hostname.length > 253 || localName.test(hostname) || hostname === 'metadata.google.internal') {
    throw new SourceError('unsafe_address', 'The address must be on the public Internet.');
  }
  if (ipaddr.isValid(hostname)) {
    if (!isPublicIp(hostname)) throw new SourceError('unsafe_address', 'The address must be on the public Internet.');
  } else {
    if (!hostname.includes('.') || !/^[a-z0-9.-]+$/.test(hostname) || hostname.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) {
      throw new SourceError('unsafe_address', 'The address must be a public hostname.');
    }
    url.hostname = hostname;
  }
  url.hash = '';
  return url;
}

const defaultResolver: Resolver = async hostname => (await lookup(hostname, { all: true, verbatim: true }))
  .map(result => ({ address: result.address, family: result.family as 4 | 6 }));

function sameIp(left: string | undefined, right: string): boolean {
  try { return !!left && ipaddr.process(left).toString() === ipaddr.process(right).toString(); }
  catch { return false; }
}

/** Connects to the validated literal IP; no DNS lookup or pooled/proxy socket is possible. */
const pinnedTransport: RequestTransport = async ({ url, address, headers, signal }) => new Promise((resolve, reject) => {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const options: https.RequestOptions = {
    protocol: url.protocol, hostname: address.address, family: address.family,
    port: url.protocol === 'https:' ? 443 : 80, path: `${url.pathname}${url.search}`,
    method: 'GET', agent: false, signal, maxHeaderSize: 16 * 1024,
    headers: { ...headers, host: url.host },
    ...(url.protocol === 'https:' ? {
      servername: ipaddr.isValid(hostname) ? '' : hostname,
      rejectUnauthorized: true,
      checkServerIdentity: (_name: string, cert: import('node:tls').PeerCertificate) => checkServerIdentity(hostname, cert),
    } : {}),
  };
  const request = (url.protocol === 'https:' ? https : http).request(options, response => {
    if (!sameIp(response.socket.remoteAddress, address.address)) {
      response.destroy(); request.destroy();
      reject(new SourceError('unsafe_address', 'The connection did not use the validated address.'));
      return;
    }
    resolve({ status: response.statusCode ?? 0, headers: response.headers, body: response, close: () => response.destroy() });
  });
  request.once('error', reject);
  request.end();
});

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new SourceError('timeout', 'The source took too long to respond.'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new SourceError('timeout', 'The source took too long to respond.'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function validator(value: string | undefined): string | undefined {
  return value && value.length <= 512 && !/[\r\n\u0000]/.test(value) ? value : undefined;
}
function headersOf(raw: TransportResponse['headers']): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) if (value !== undefined) result[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  return result;
}

export class SafeHttpClient {
  private readonly resolver: Resolver;
  private readonly transport: RequestTransport;
  private readonly options: Required<Omit<SafeHttpOptions, 'resolver' | 'transport'>>;
  private active = 0;
  private hosts = new Map<string, number>();
  constructor(options: SafeHttpOptions = {}) {
    this.resolver = options.resolver ?? defaultResolver;
    this.transport = options.transport ?? pinnedTransport;
    this.options = {
      timeoutMs: options.timeoutMs ?? 15_000, maxCompressedBytes: options.maxCompressedBytes ?? 2 * 1024 * 1024,
      maxBodyBytes: options.maxBodyBytes ?? 4 * 1024 * 1024, maxRedirects: options.maxRedirects ?? 4,
      maxConcurrent: options.maxConcurrent ?? 16, maxConcurrentPerHost: options.maxConcurrentPerHost ?? 2,
    };
    for (const [key, value] of Object.entries(this.options)) {
      if (!Number.isSafeInteger(value) || value < (key === 'maxRedirects' ? 0 : 1)) throw new Error(`Invalid SafeHttpClient option: ${key}`);
    }
    if (this.options.timeoutMs > 60_000 || this.options.maxRedirects > 10 || this.options.maxBodyBytes > 16 * 1024 * 1024 || this.options.maxCompressedBytes > 16 * 1024 * 1024) throw new Error('SafeHttpClient limits are too large.');
  }

  async get(value: string, validators: Validators = {}): Promise<HttpResponse> {
    let url = validatePublicUrl(value);
    if (this.active >= this.options.maxConcurrent) throw new SourceError('network_limit', 'Too many sources are being fetched.');
    this.active++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const signal = controller.signal;
    const initialOrigin = url.origin;
    try {
      for (let redirects = 0; ; redirects++) {
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const count = this.hosts.get(hostname) ?? 0;
        if (count >= this.options.maxConcurrentPerHost) throw new SourceError('network_limit', 'Too many requests to this hostname.');
        this.hosts.set(hostname, count + 1);
        let response: TransportResponse | undefined;
        try {
          let addresses: ResolvedAddress[];
          if (ipaddr.isValid(hostname)) {
            addresses = [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv4' ? 4 : 6 }];
          } else {
            try { addresses = await abortable(this.resolver(hostname), signal); }
            catch (error) { if (error instanceof SourceError) throw error; throw new SourceError('dns_failed', 'The source hostname could not be resolved.'); }
          }
          if (!addresses.length || addresses.length > 16 || addresses.some(address => !isPublicIp(address.address) || ![4, 6].includes(address.family) || (ipaddr.parse(address.address).kind() === 'ipv4' ? 4 : 6) !== address.family)) {
            throw new SourceError('unsafe_address', 'Every resolved address must be on the public Internet.');
          }
          const headers: Record<string, string> = { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8', 'accept-encoding': 'gzip, deflate, br', 'user-agent': 'FeedRelay/0.1 (+public-feed-fetcher)' };
          if (url.origin === initialOrigin) {
            const etag = validator(validators.etag), lastModified = validator(validators.lastModified);
            if (etag) headers['if-none-match'] = etag;
            if (lastModified) headers['if-modified-since'] = lastModified;
          }
          const selected = addresses[0]!;
          const address = { address: ipaddr.parse(selected.address).toString(), family: selected.family };
          response = await abortable(this.transport({ url, address, headers, signal }), signal);
          const responseHeaders = headersOf(response.headers);
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (redirects >= this.options.maxRedirects) throw new SourceError('too_many_redirects', 'The source redirected too many times.');
            if (!responseHeaders.location) throw new SourceError('network_failed', 'The source returned a redirect without a location.');
            url = validatePublicUrl(responseHeaders.location, url.toString());
            continue;
          }
          if (response.status === 304) return { status: 304, body: Buffer.alloc(0), headers: responseHeaders, url: url.toString() };
          const body = await this.readBody(response, responseHeaders, signal);
          return { status: response.status, body, headers: responseHeaders, url: url.toString() };
        } finally {
          response?.close?.();
          const remaining = (this.hosts.get(hostname) ?? 1) - 1;
          if (remaining) this.hosts.set(hostname, remaining); else this.hosts.delete(hostname);
        }
      }
    } catch (error) {
      if (error instanceof SourceError) throw error;
      if (signal.aborted) throw new SourceError('timeout', 'The source took too long to respond.');
      throw new SourceError('network_failed', 'The source could not be fetched.');
    } finally { clearTimeout(timer); controller.abort(); this.active--; }
  }

  private async readBody(response: TransportResponse, headers: Record<string, string>, signal: AbortSignal): Promise<Buffer> {
    const length = Number(headers['content-length']);
    if (Number.isFinite(length) && length > this.options.maxCompressedBytes) throw new SourceError('body_too_large', 'The source response is too large.');
    const chunks: Buffer[] = [];
    let bytes = 0;
    const iterator = response.body[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await abortable(iterator.next(), signal);
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > this.options.maxCompressedBytes) throw new SourceError('body_too_large', 'The source response is too large.');
        chunks.push(Buffer.from(next.value));
      }
    } finally { void iterator.return?.().catch(() => undefined); }
    const buffer = Buffer.concat(chunks, bytes);
    const encoding = (headers['content-encoding'] ?? 'identity').trim().toLowerCase();
    if (encoding === 'identity' || encoding === '') {
      if (bytes > this.options.maxBodyBytes) throw new SourceError('body_too_large', 'The decoded source response is too large.');
      return buffer;
    }
    const decompress = encoding === 'gzip' ? promisify(gunzip) : encoding === 'deflate' ? promisify(inflate) : encoding === 'br' ? promisify(brotliDecompress) : undefined;
    if (!decompress) throw new SourceError('unsupported_encoding', 'The source uses an unsupported content encoding.');
    try { return await abortable(decompress(buffer, { maxOutputLength: this.options.maxBodyBytes }), signal); }
    catch (error) {
      if (error instanceof SourceError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new SourceError('body_too_large', 'The decoded source response is too large.');
      throw new SourceError('invalid_encoding', 'The source response could not be decompressed.');
    }
  }
}

export const defaultHttpClient = new SafeHttpClient();
