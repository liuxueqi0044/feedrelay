import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { SourceError } from './errors.js';

export const MAX_XML_BYTES = 4 * 1024 * 1024;
export type XmlObject = Record<string, unknown>;

export function decodeDocument(body: Buffer, contentType?: string): string {
  if (body.length > MAX_XML_BYTES) throw new SourceError('body_too_large', 'The document is too large.');
  const declared = body.subarray(0, 256).toString('ascii').match(/<\?xml\s[^>]*encoding\s*=\s*["']([^"']+)["']/i)?.[1];
  const charset = contentType?.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1];
  let encoding = charset ?? declared ?? 'utf-8';
  if (body[0] === 0xff && body[1] === 0xfe) encoding = 'utf-16le';
  else if (body[0] === 0xfe && body[1] === 0xff) encoding = 'utf-16be';
  else if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) encoding = 'utf-8';
  else if (body[0] === 0x00 && body[1] === 0x3c) encoding = 'utf-16be';
  else if (body[0] === 0x3c && body[1] === 0x00) encoding = 'utf-16le';
  try { return new TextDecoder(encoding, { fatal: true }).decode(body).replace(/^\uFEFF/, ''); }
  catch { throw new SourceError('invalid_encoding', 'The document uses an invalid or unsupported text encoding.'); }
}

export function parseSafeXml(xml: string): XmlObject {
  if (Buffer.byteLength(xml) > MAX_XML_BYTES) throw new SourceError('body_too_large', 'The XML document is too large.');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new SourceError('unsafe_xml', 'DTD and entity declarations are not allowed.');
  const entityScope = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g, '');
  if (/&(?!(?:amp|lt|gt|quot|apos|#(?:[0-9]{1,7}|x[0-9a-fA-F]{1,6}));)/.test(entityScope)) {
    throw new SourceError('unsafe_xml', 'Only built-in XML entities and character references are allowed.');
  }
  let depth = 0, nodes = 0;
  const tags = xml.matchAll(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z_][^>]*>/g);
  for (const match of tags) {
    const tag = match[0];
    if (tag.startsWith('<?') || tag.startsWith('<!')) continue;
    if (++nodes > 50_000) throw new SourceError('invalid_xml', 'The XML document contains too many elements.');
    if (tag.startsWith('</')) depth--;
    else if (!tag.endsWith('/>')) depth++;
    if (depth > 64) throw new SourceError('invalid_xml', 'The XML document is nested too deeply.');
  }
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new SourceError('invalid_xml', 'The source returned malformed XML.');
  try {
    const parser = new XMLParser({
      ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text',
      parseTagValue: false, parseAttributeValue: false, trimValues: false,
      removeNSPrefix: true, processEntities: false, htmlEntities: false,
      // Preserve mixed XHTML order; object-mode parsers group child tags before text.
      stopNodes: ['*.title', '*.content', '*.summary', '*.description', '*.encoded'],
      isArray: name => ['item', 'entry', 'outline', 'link', 'category'].includes(name),
    });
    return parser.parse(xml) as XmlObject;
  } catch { throw new SourceError('invalid_xml', 'The source returned malformed XML.'); }
}

export function object(value: unknown): XmlObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as XmlObject : {};
}
export function list(value: unknown): unknown[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
export function xmlText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(xmlText).join(' ');
  return Object.entries(object(value)).filter(([key]) => !key.startsWith('@_')).map(([, item]) => xmlText(item)).join(' ');
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (whole, entity: string) => {
    if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? whole;
    const point = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '';
  });
}

function stripMarkup(value: string): string {
  const parts: string[] = [];
  let position = 0, suppressed: string | undefined;
  // Index scanning stays linear even when a feed contains many unclosed script tags.
  while (position < value.length) {
    const start = value.indexOf('<', position);
    if (start < 0) { if (!suppressed) parts.push(value.slice(position)); break; }
    if (!suppressed) parts.push(value.slice(position, start));
    if (value.startsWith('<!--', start)) {
      const end = value.indexOf('-->', start + 4);
      position = end < 0 ? value.length : end + 3;
      continue;
    }
    const end = value.indexOf('>', start + 1);
    if (end < 0) { if (!suppressed) parts.push(value.slice(start)); break; }
    const tag = value.slice(start + 1, Math.min(end, start + 257)).match(/^\s*(\/?)\s*(script|style)(?:\s|\/|$)/i);
    if (tag) {
      const name = tag[2]!.toLowerCase();
      if (!tag[1] && !suppressed) suppressed = name;
      else if (tag[1] && suppressed === name) suppressed = undefined;
    }
    if (!suppressed) parts.push(' ');
    position = end + 1;
  }
  return parts.join('');
}

/** Plain text is safe for search and Telegram formatting; HTML is never retained. */
export function normalizeText(value: unknown, maxLength = 20_000): string {
  const decoded = decodeEntities(decodeEntities(xmlText(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')));
  return stripMarkup(decoded)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function xmlEscape(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
}
