import { SourceError } from './errors.js';
import { validatePublicUrl } from './http.js';
import { decodeDocument, decodeEntities, list, normalizeText, object, parseSafeXml, xmlEscape, xmlText } from './xml.js';

export interface OpmlFeed { url: string; title: string; htmlUrl?: string }
export interface OpmlDocument { title: string; feeds: OpmlFeed[] }

export function parseOpml(input: string | Buffer, validateUrl: (input: string) => URL = validatePublicUrl): OpmlDocument {
  const xml = typeof input === 'string' ? input : decodeDocument(input);
  const document = parseSafeXml(xml);
  const opml = object(document.opml);
  if (!Object.keys(opml).length || opml.body === undefined) throw new SourceError('invalid_opml', 'Upload a valid OPML document with a body.');
  const feeds: OpmlFeed[] = [];
  const seen = new Set<string>();
  function visit(value: unknown, depth = 0): void {
    if (depth > 32) throw new SourceError('invalid_opml', 'The OPML folders are nested too deeply.');
    for (const raw of list(value)) {
      const outline = object(raw);
      const rawUrl = decodeEntities(xmlText(outline['@_xmlUrl'])).trim();
      if (rawUrl) {
        const url = validateUrl(rawUrl).toString();
        if (!seen.has(url)) {
          if (feeds.length >= 1000) throw new SourceError('too_many_items', 'An OPML import can contain at most 1,000 feeds.');
          const title = normalizeText(outline['@_title'] ?? outline['@_text'], 1000) || new URL(url).hostname;
          let htmlUrl: string | undefined;
          const rawHtml = decodeEntities(xmlText(outline['@_htmlUrl'])).trim();
          if (rawHtml) { try { htmlUrl = validateUrl(rawHtml).toString(); } catch { /* Optional site links do not affect import. */ } }
          feeds.push({ url, title, ...(htmlUrl ? { htmlUrl } : {}) });
          seen.add(url);
        }
      }
      if (outline.outline !== undefined) visit(outline.outline, depth + 1);
    }
  }
  visit(object(opml.body).outline);
  return { title: normalizeText(object(opml.head).title, 1000) || 'Subscriptions', feeds };
}

export function exportOpml(feeds: readonly OpmlFeed[], title = 'FeedRelay subscriptions', validateUrl: (input: string) => URL = validatePublicUrl): string {
  if (feeds.length > 1000) throw new SourceError('too_many_items', 'An OPML export can contain at most 1,000 feeds.');
  const outlines = feeds.map(feed => {
    const url = validateUrl(feed.url).toString();
    const text = xmlEscape(normalizeText(feed.title, 1000) || new URL(url).hostname);
    const htmlUrl = feed.htmlUrl ? ` htmlUrl="${xmlEscape(validateUrl(feed.htmlUrl).toString())}"` : '';
    return `    <outline type="rss" text="${text}" title="${text}" xmlUrl="${xmlEscape(url)}"${htmlUrl}/>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>${xmlEscape(normalizeText(title, 1000))}</title></head>\n  <body>\n${outlines.join('\n')}\n  </body>\n</opml>\n`;
}
