/**
 * Minimal XML helpers for the DLNA/UPnP renderer.
 *
 * UPnP control requests are small, well-formed documents, so a dependency-free
 * regex reader is sufficient and keeps the pkg sidecar bundle small. We never
 * need to build a general DOM.
 */

/** Escape a value for inclusion in an XML text node or attribute. */
export function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Decode the five predefined XML entities plus numeric character references. */
export function unescapeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Read the text content of the first `<name>` element in `xml`.
 * Namespace prefixes are matched literally, so callers pass e.g. `dc:title`.
 */
export function readElement(xml: string, name: string): string | undefined {
  const pattern = new RegExp(`<${escapeRegExp(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeRegExp(name)}>`, 'i');
  const match = pattern.exec(xml);
  if (!match) return undefined;
  return unescapeXml(stripCdata(match[1])).trim();
}

/** Read an attribute from the first `<name ...>` element in `xml`. */
export function readAttribute(xml: string, name: string, attribute: string): string | undefined {
  const element = new RegExp(`<${escapeRegExp(name)}(\\s[^>]*?)/?>`, 'i').exec(xml);
  if (!element) return undefined;
  const attr = new RegExp(`${escapeRegExp(attribute)}\\s*=\\s*"([^"]*)"`, 'i').exec(element[1]);
  return attr ? unescapeXml(attr[1]).trim() : undefined;
}

/** Read every `<name ...>text</name>` occurrence, returning the inner text. */
export function readAllElements(xml: string, name: string): string[] {
  const pattern = new RegExp(`<${escapeRegExp(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeRegExp(name)}>`, 'gi');
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    out.push(unescapeXml(stripCdata(match[1])).trim());
  }
  return out;
}

function stripCdata(value: string): string {
  const match = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(value);
  return match ? match[1] : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── DIDL-Lite ────────────────────────────────────────────────────────────────

export interface DidlMetadata {
  title?: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
  upnpClass?: string;
  mimeType?: string;
  durationSeconds?: number;
}

/**
 * Parse a DIDL-Lite document (as carried in `CurrentURIMetaData`) into the
 * fields the kiosk UI and DLNA state need. Returns an empty object for empty or
 * unparseable input rather than throwing — metadata is always optional.
 */
export function parseDidlLite(xml: string | undefined | null): DidlMetadata {
  if (!xml) return {};
  const text = String(xml).trim();
  if (!text) return {};

  const metadata: DidlMetadata = {};

  const title = readElement(text, 'dc:title') ?? readElement(text, 'title');
  if (title) metadata.title = title;

  const artist =
    readElement(text, 'upnp:artist') ??
    readElement(text, 'upnp:albumArtist') ??
    readElement(text, 'dc:creator');
  if (artist) metadata.artist = artist;

  const album = readElement(text, 'upnp:album');
  if (album) metadata.album = album;

  const artwork = readElement(text, 'upnp:albumArtURI');
  if (artwork) metadata.artworkUrl = artwork;

  const upnpClass = readElement(text, 'upnp:class');
  if (upnpClass) metadata.upnpClass = upnpClass;

  const protocolInfo = readAttribute(text, 'res', 'protocolInfo');
  if (protocolInfo) {
    // protocolInfo = "http-get:*:audio/mpeg:DLNA.ORG_PN=MP3;..."
    const parts = protocolInfo.split(':');
    const mime = parts[2]?.trim();
    if (mime && mime !== '*') metadata.mimeType = mime;
  }

  const duration = readAttribute(text, 'res', 'duration');
  const seconds = parseUpnpDuration(duration);
  if (seconds !== undefined) metadata.durationSeconds = seconds;

  return metadata;
}

/** Parse a UPnP `H:MM:SS[.fraction]` duration into seconds. */
export function parseUpnpDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return undefined;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3], 10);
  const fraction = match[4] ? parseFloat(`0.${match[4]}`) : 0;
  return hours * 3600 + minutes * 60 + seconds + fraction;
}

/** Format seconds as a UPnP `H:MM:SS` duration. */
export function formatUpnpDuration(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// ─── SOAP ─────────────────────────────────────────────────────────────────────

export interface SoapAction {
  service: string;
  action: string;
}

/**
 * Parse a `SOAPACTION` header value such as
 * `"urn:schemas-upnp-org:service:AVTransport:1#Play"`.
 */
export function parseSoapActionHeader(header: string | undefined): SoapAction | null {
  if (!header) return null;
  const cleaned = header.trim().replace(/^"|"$/g, '');
  const hash = cleaned.lastIndexOf('#');
  if (hash < 0) return null;
  const service = cleaned.slice(0, hash);
  const action = cleaned.slice(hash + 1);
  if (!service || !action) return null;
  return { service, action };
}

/**
 * Build a SOAP envelope wrapping the action response `innerXml`.
 * `serviceType` is the full UPnP service type, e.g.
 * `urn:schemas-upnp-org:service:AVTransport:1`.
 */
export function buildSoapEnvelope(serviceType: string, action: string, innerXml: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body>' +
    `<u:${action}Response xmlns:u="${serviceType}">` +
    innerXml +
    `</u:${action}Response>` +
    '</s:Body>' +
    '</s:Envelope>'
  );
}

/** Build a SOAP fault envelope. */
export function buildSoapFault(errorCode: number, description: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body>' +
    '<s:Fault>' +
    '<faultcode>s:Client</faultcode>' +
    '<faultstring>UPnPError</faultstring>' +
    '<detail>' +
    '<UPnPError xmlns="urn:schemas-upnp-org:control-1-0">' +
    `<errorCode>${errorCode}</errorCode>` +
    `<errorDescription>${escapeXml(description)}</errorDescription>` +
    '</UPnPError>' +
    '</detail>' +
    '</s:Fault>' +
    '</s:Body>' +
    '</s:Envelope>'
  );
}