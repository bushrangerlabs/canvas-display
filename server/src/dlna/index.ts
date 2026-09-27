/**
 * DLNA MediaRenderer — HTTP control surface + lifecycle.
 *
 * Serves the UPnP device/service descriptions, handles SOAP control requests
 * and GENA event subscriptions, and drives the injected playback adapter.
 * Started from the sidecar's composition root (`server/src/index.ts`).
 */

import http, { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import { DlnaRenderer, DlnaPlaybackAdapter, DlnaSubscriber, UpnpError } from './renderer';
import { SsdpServer, detectInterfaceAddress } from './ssdp';
import {
  AV_TRANSPORT_TYPE,
  RENDERING_CONTROL_TYPE,
  CONNECTION_MANAGER_TYPE,
  buildDeviceDescription,
  buildServiceDescription,
} from './descriptions';
import { buildSoapEnvelope, buildSoapFault, escapeXml, parseSoapActionHeader, readElement } from './xml';

export interface DlnaOptions {
  enabled: boolean;
  port: number;
  uuid: string;
  friendlyName: string;
  manufacturer: string;
  modelName: string;
  modelNumber: string;
  /** Override the advertised LAN address (defaults to auto-detection). */
  host?: string;
  /** Set false to run the HTTP control surface without SSDP (tests / debugging). */
  ssdp?: boolean;
  adapter: DlnaPlaybackAdapter;
}

export interface DlnaHandle {
  renderer: DlnaRenderer;
  port: number;
  baseUrl: string;
  stop(): void;
}

const CONTROL_PATHS: Record<string, string> = {
  '/control/AVTransport': AV_TRANSPORT_TYPE,
  '/control/RenderingControl': RENDERING_CONTROL_TYPE,
  '/control/ConnectionManager': CONNECTION_MANAGER_TYPE,
};

const EVENT_PATHS: Record<string, string> = {
  '/event/AVTransport': AV_TRANSPORT_TYPE,
  '/event/RenderingControl': RENDERING_CONTROL_TYPE,
  '/event/ConnectionManager': CONNECTION_MANAGER_TYPE,
};

let active: DlnaHandle | null = null;

/** Build the URL of the HTML video wrapper the kiosk floating WebView loads. */
export function videoWrapperUrl(baseUrl: string, mediaUrl: string, title?: string): string {
  const params = new URLSearchParams({ url: mediaUrl });
  if (title) params.set('title', title);
  return `${baseUrl}/video?${params.toString()}`;
}

export async function startDlna(options: DlnaOptions): Promise<DlnaHandle | null> {
  if (!options.enabled) {
    console.log('[dlna] disabled');
    return null;
  }
  if (active) return active;

  const interfaceAddress = options.host?.trim() || detectInterfaceAddress();
  const server = http.createServer();
  const renderer = new DlnaRenderer(options.adapter, (subscriber, body) => sendEvent(subscriber, body));

  const baseUrl = await listen(server, options.port, interfaceAddress);
  const serverHeader = `Linux/5.0 UPnP/1.0 CanvasDisplay/${options.modelNumber}`;

  const descriptionConfig = {
    uuid: options.uuid,
    friendlyName: options.friendlyName,
    manufacturer: options.manufacturer,
    modelName: options.modelName,
    modelNumber: options.modelNumber,
    baseUrl,
  };

  server.on('request', (req, res) => {
    handleRequest(req, res, renderer, descriptionConfig, baseUrl).catch((err) => {
      console.warn('[dlna] request handler error:', err instanceof Error ? err.message : err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  const ssdp = options.ssdp === false
    ? null
    : new SsdpServer({
        uuid: options.uuid,
        interfaceAddress,
        location: `${baseUrl}/description.xml`,
        server: serverHeader,
      });
  ssdp?.start();

  const pruneTimer = setInterval(() => renderer.pruneSubscribers(), 60_000);

  active = {
    renderer,
    port: options.port,
    baseUrl,
    stop() {
      clearInterval(pruneTimer);
      ssdp?.stop();
      server.close();
      active = null;
    },
  };

  console.log(`[dlna] MediaRenderer "${options.friendlyName}" on ${baseUrl} (uuid ${options.uuid})`);
  return active;
}

export function stopDlna(): void {
  active?.stop();
}

export function getDlnaHandle(): DlnaHandle | null {
  return active;
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function listen(server: http.Server, port: number, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      resolve(`http://${host}:${boundPort}`);
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  renderer: DlnaRenderer,
  descriptionConfig: Parameters<typeof buildDeviceDescription>[0],
  baseUrl: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', baseUrl);
  const path = url.pathname;

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (path === '/description.xml' || path === '/rootDesc.xml') {
      return sendXml(res, buildDeviceDescription(descriptionConfig));
    }
    const scpd = buildServiceDescription(path);
    if (scpd) return sendXml(res, scpd);
    if (path === '/video') {
      return sendHtml(res, buildVideoPage(url.searchParams.get('url') ?? '', url.searchParams.get('title') ?? ''));
    }
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...renderer.getState() }));
      return;
    }
    res.writeHead(404);
    res.end();
    return;
  }

  if (req.method === 'POST' && CONTROL_PATHS[path]) {
    return handleControl(req, res, renderer, CONTROL_PATHS[path]);
  }

  if (req.method === 'SUBSCRIBE' && EVENT_PATHS[path]) {
    return handleSubscribe(req, res, renderer, EVENT_PATHS[path]);
  }

  if (req.method === 'UNSUBSCRIBE' && EVENT_PATHS[path]) {
    const sid = String(req.headers['sid'] ?? '').trim();
    renderer.unsubscribe(sid);
    res.writeHead(200, { SID: sid });
    res.end();
    return;
  }

  const knownPath =
    path === '/description.xml' ||
    path === '/rootDesc.xml' ||
    path === '/video' ||
    path === '/health' ||
    Boolean(CONTROL_PATHS[path]) ||
    Boolean(EVENT_PATHS[path]) ||
    buildServiceDescription(path) !== null;
  res.writeHead(knownPath ? 405 : 404);
  res.end();
}

async function handleControl(
  req: IncomingMessage,
  res: ServerResponse,
  renderer: DlnaRenderer,
  serviceType: string,
): Promise<void> {
  const body = await readBody(req);
  const soapAction = parseSoapActionHeader(String(req.headers['soapaction'] ?? ''));
  const action = soapAction?.action ?? readElement(body, 'u:Action') ?? '';

  if (!action) {
    return sendSoapFault(res, 401, 'Invalid Action');
  }

  const args = extractActionArgs(body, action);

  try {
    const inner = await renderer.handleAction(serviceType, action, args);
    const envelope = buildSoapEnvelope(serviceType, action, inner);
    res.writeHead(200, {
      'Content-Type': 'text/xml; charset="utf-8"',
      EXT: '',
      SERVER: 'Linux/5.0 UPnP/1.0 CanvasDisplay',
    });
    res.end(envelope);
  } catch (err) {
    if (err instanceof UpnpError) return sendSoapFault(res, err.code, err.description);
    console.warn('[dlna] control action failed:', err instanceof Error ? err.message : err);
    sendSoapFault(res, 501, 'Action Failed');
  }
}

function handleSubscribe(
  req: IncomingMessage,
  res: ServerResponse,
  renderer: DlnaRenderer,
  serviceType: string,
): void {
  const sid = String(req.headers['sid'] ?? '').trim();
  const timeout = parseTimeout(String(req.headers['timeout'] ?? ''));

  if (sid) {
    const renewed = renderer.renew(sid, timeout);
    if (!renewed) {
      res.writeHead(412);
      res.end();
      return;
    }
    res.writeHead(200, { SID: renewed.sid, TIMEOUT: `Second-${timeout}` });
    res.end();
    return;
  }

  const callbackHeader = String(req.headers['callback'] ?? '');
  const callbackUrl = extractCallbackUrl(callbackHeader);
  if (!callbackUrl) {
    res.writeHead(400);
    res.end();
    return;
  }

  const subscriber = renderer.subscribe(serviceType, callbackUrl, timeout);
  res.writeHead(200, { SID: subscriber.sid, TIMEOUT: `Second-${timeout}` });
  res.end();
  renderer.sendInitialEvent(subscriber);
}

function extractCallbackUrl(header: string): string | null {
  const match = /<([^>]+)>/.exec(header);
  return match ? match[1].trim() : null;
}

function parseTimeout(header: string): number {
  const match = /Second-(\d+)/i.exec(header);
  if (match) return parseInt(match[1], 10);
  if (/infinite/i.test(header)) return 1800;
  return 1800;
}

function extractActionArgs(body: string, action: string): Record<string, string> {
  const args: Record<string, string> = {};
  const actionBlock = new RegExp(`<u:${action}[^>]*>([\\s\\S]*?)</u:${action}>`, 'i').exec(body);
  const scope = actionBlock ? actionBlock[1] : body;
  const argPattern = /<([A-Za-z0-9_]+)>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = argPattern.exec(scope)) !== null) {
    args[match[1]] = unescapeXmlText(match[2]);
  }
  return args;
}

function unescapeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function sendXml(res: ServerResponse, xml: string): void {
  res.writeHead(200, { 'Content-Type': 'text/xml; charset="utf-8"' });
  res.end(xml);
}

function sendSoapFault(res: ServerResponse, code: number, description: string): void {
  res.writeHead(500, { 'Content-Type': 'text/xml; charset="utf-8"' });
  res.end(buildSoapFault(code, description));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset="utf-8"', 'Cache-Control': 'no-store' });
  res.end(html);
}

// ─── GENA event delivery ──────────────────────────────────────────────────────

function sendEvent(subscriber: DlnaSubscriber, body: string): void {
  let target: URL;
  try {
    target = new URL(subscriber.callbackUrl);
  } catch {
    return;
  }
  subscriber.seq += 1;
  const payload = Buffer.from(body, 'utf8');
  const request = http.request(
    {
      method: 'NOTIFY',
      hostname: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      headers: {
        HOST: `${target.hostname}:${target.port || 80}`,
        'CONTENT-TYPE': 'text/xml; charset="utf-8"',
        NT: 'upnp:event',
        NTS: 'upnp:propchange',
        SID: subscriber.sid,
        SEQ: String(subscriber.seq),
        'CONTENT-LENGTH': String(payload.length),
      },
    },
    (res) => res.resume(),
  );
  request.on('error', () => { /* subscriber gone — prune on next sweep */ });
  request.setTimeout(5000, () => request.destroy());
  request.end(payload);
}

// ─── Video wrapper page ───────────────────────────────────────────────────────

function buildVideoPage(mediaUrl: string, title: string): string {
  const safeUrl = escapeXml(mediaUrl);
  const safeTitle = escapeXml(title || 'Canvas Display');
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<title>${safeTitle}</title>` +
    '<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}' +
    'video{width:100%;height:100%;object-fit:contain;background:#000}</style>' +
    '</head><body>' +
    `<video src="${safeUrl}" autoplay controls playsinline></video>` +
    '</body></html>'
  );
}