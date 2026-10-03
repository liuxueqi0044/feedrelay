import { createHash } from 'node:crypto';
import { SourceError } from './errors.js';
import { defaultHttpClient, SafeHttpClient, validatePublicUrl, type HttpResponse, type Validators } from './http.js';
import { decodeDocument, decodeEntities, list, normalizeText, object, parseSafeXml, xmlText, type XmlObject } from './xml.js';

export interface NormalizedItem {
  title: string;
  summary: string;
  url?: string;
  externalId?: string;
  contentHash: string;
  publishedAt?: string;
  updatedAt?: string;
  identityCandidates: string[];
}
export interface FeedSnapshot extends Validators {
  kind: 'snapshot';
  url: string;
  title: string;
  siteUrl?: string;
  items: NormalizedItem[];
}
export interface FeedNotModified extends Validators { kind: 'not_modified'; url: string }
export type FeedResult = FeedSnapshot | FeedNotModified;
export interface FeedClient { get(url: string, validators?: Validators): Promise<HttpResponse> }

function safeLink(value: unknown, base: string): string | undefined {
  const link = decodeEntities(xmlText(value)).trim();
  if (!link) return undefined;
  try { return validatePublicUrl(link, base).toString(); } catch { return undefined; }
}
function date(value: unknown): string | undefined {
  const text = xmlText(value).trim();
  if (!text || text.length > 128) return undefined;
  const milliseconds = Date.parse(text);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}
function baseOf(node: XmlObject, base: string): string { return safeLink(node['@_base'], base) ?? base; }
function first(value: unknown): unknown { return Array.isArray(value) ? value[0] : value; }
function atomLink(value: unknown, base: string): string | undefined {
  for (const raw of list(value)) {
    const link = object(raw);
    const rel = xmlText(link['@_rel']).trim().toLowerCase();
    if (!rel || rel === 'alternate') {
      const href = safeLink(link['@_href'], baseOf(link, base));
      if (href) return href;
    }
  }
  return undefined;
}
function normalizedItem(raw: XmlObject, base: string, atom: boolean): NormalizedItem | undefined {
  base = baseOf(raw, base);
  const title = normalizeText(raw.title, 1000);
  const summary = normalizeText(atom ? raw.content ?? raw.summary : raw.encoded ?? raw.description, 20_000);
  const id = decodeEntities(xmlText(atom ? raw.id : raw.guid)).trim().slice(0, 2048);
  const externalId = id || undefined;
  let url = atom ? atomLink(raw.link, base) : safeLink(first(raw.link), base);
  if (!url && !atom && externalId && xmlText(object(raw.guid)['@_isPermaLink']).toLowerCase() !== 'false') url = safeLink(externalId, base);
  if (!title && !summary && !url && !externalId) return undefined;
  const contentHash = createHash('sha256').update(JSON.stringify([title, summary, url ?? ''])).digest('hex');
  const identityCandidates = [externalId ? `external:${externalId}` : undefined, url ? `url:${url}` : undefined, `content:${contentHash}`].filter((entry): entry is string => !!entry);
  return {
    title: title || '(Untitled)', summary, contentHash, identityCandidates,
    ...(url ? { url } : {}), ...(externalId ? { externalId } : {}),
    ...(date(atom ? raw.published : raw.pubDate ?? raw.date) ? { publishedAt: date(atom ? raw.published : raw.pubDate ?? raw.date) } : {}),
    ...(date(atom ? raw.updated : raw.updated) ? { updatedAt: date(raw.updated) } : {}),
  };
}

export function parseFeed(xml: string, feedUrl: string): FeedSnapshot {
  const sourceUrl = validatePublicUrl(feedUrl).toString();
  const document = parseSafeXml(xml);
  const atom = document.feed !== undefined;
  const root = atom ? object(document.feed) : object(object(document.rss).channel);
  if (!Object.keys(root).length) throw new SourceError('not_a_feed', 'The URL did not return an RSS 2.0 or Atom feed.');
  const base = baseOf(root, sourceUrl);
  const rawItems = list(atom ? root.entry : root.item);
  if (rawItems.length > 1000) throw new SourceError('too_many_items', 'The feed contains more than 1,000 items.');
  const items: NormalizedItem[] = [];
  const seen = new Set<string>();
  for (const raw of rawItems) {
    const item = normalizedItem(object(raw), base, atom);
    if (!item || seen.has(item.identityCandidates[0]!)) continue;
    seen.add(item.identityCandidates[0]!);
    items.push(item);
  }
  const siteUrl = atom ? atomLink(root.link, base) : safeLink(first(root.link), base);
  return { kind: 'snapshot', url: sourceUrl, title: normalizeText(root.title, 1000) || new URL(sourceUrl).hostname, items, ...(siteUrl ? { siteUrl } : {}) };
}

function responseValidators(response: HttpResponse): Validators {
  const output: Validators = {};
  for (const [header, key] of [['etag', 'etag'], ['last-modified', 'lastModified']] as const) {
    const value = response.headers[header];
    if (value && value.length <= 512 && !/[\r\n\u0000]/.test(value)) output[key] = value;
  }
  return output;
}
function checkStatus(response: HttpResponse): void {
  if (response.status < 200 || response.status >= 300) throw new SourceError('http_error', `The source returned HTTP ${response.status}.`, response.status);
}
function looksHtml(xml: string, type?: string): boolean { return type?.toLowerCase().includes('text/html') === true || /^\s*(?:<!doctype\s+html\b|<html\b)/i.test(xml); }

function discoverCandidates(html: string, pageUrl: string): string[] {
  const candidates: string[] = [];
  for (const match of html.slice(0, 1024 * 1024).matchAll(/<link\b[^>]{0,8192}>/gi)) {
    const attributes: Record<string, string> = {};
    for (const attribute of match[0].matchAll(/([a-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      attributes[attribute[1]!.toLowerCase()] = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
    }
    if (!attributes.rel?.toLowerCase().split(/\s+/).includes('alternate')) continue;
    if (!/^(?:application\/(?:rss\+xml|atom\+xml|xml)|text\/xml)(?:\s*;|$)/i.test(attributes.type ?? '')) continue;
    const candidate = safeLink(attributes.href, pageUrl);
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
    if (candidates.length >= 8) break;
  }
  return candidates;
}

async function discoverFromResponse(response: HttpResponse, client: FeedClient): Promise<FeedSnapshot> {
  checkStatus(response);
  const content = decodeDocument(response.body, response.headers['content-type']);
  if (!looksHtml(content, response.headers['content-type'])) return { ...parseFeed(content, response.url), ...responseValidators(response) };
  const candidates = discoverCandidates(content, response.url);
  if (!candidates.length) throw new SourceError('feed_not_found', 'This page does not advertise an RSS or Atom feed. Enter the feed URL directly.');
  for (const url of candidates) {
    try {
      const candidate = await client.get(url);
      checkStatus(candidate);
      const text = decodeDocument(candidate.body, candidate.headers['content-type']);
      if (looksHtml(text, candidate.headers['content-type'])) continue;
      return { ...parseFeed(text, candidate.url), ...responseValidators(candidate) };
    } catch (error) {
      // Each candidate is independently validated by the same safe client. No nested discovery.
      if (error instanceof SourceError && ['network_limit', 'timeout'].includes(error.code)) throw error;
    }
  }
  throw new SourceError('feed_not_found', 'The advertised feed links did not return a valid RSS or Atom feed.');
}

export async function fetchFeed(url: string, validators: Validators = {}, client: FeedClient = defaultHttpClient): Promise<FeedResult> {
  validatePublicUrl(url);
  const response = await client.get(url, validators);
  if (response.status === 304) {
    if (!validators.etag && !validators.lastModified) throw new SourceError('http_error', 'The source returned 304 without a conditional request.', 304);
    return { kind: 'not_modified', url: response.url, ...validators, ...responseValidators(response) };
  }
  return discoverFromResponse(response, client);
}

export async function discoverFeed(url: string, client: FeedClient = defaultHttpClient): Promise<FeedSnapshot> {
  validatePublicUrl(url);
  return discoverFromResponse(await client.get(url), client);
}

// Keep the concrete safe client discoverable alongside FeedClient for dependency injection.
export { SafeHttpClient };
