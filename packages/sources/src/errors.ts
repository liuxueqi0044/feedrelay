export type SourceErrorCode =
  | 'invalid_url' | 'credentials_not_allowed' | 'unsafe_address' | 'dns_failed'
  | 'network_failed' | 'network_limit' | 'timeout' | 'too_many_redirects'
  | 'body_too_large' | 'unsupported_encoding' | 'invalid_encoding'
  | 'http_error' | 'invalid_xml' | 'unsafe_xml' | 'not_a_feed'
  | 'feed_not_found' | 'invalid_opml' | 'too_many_items';

export class SourceError extends Error {
  constructor(public readonly code: SourceErrorCode, message: string, public readonly status?: number) {
    super(message);
    this.name = 'SourceError';
  }
}
