/**
 * SSDP (UPnP discovery) responder for the Canvas Display DLNA renderer.
 *
 * Answers M-SEARCH probes and announces itself with NOTIFY alive/byebye so
 * Home Assistant's `dlna_dmr` integration (and Music Assistant's DLNA player
 * provider) can discover the device without manual configuration.
 */

import dgram, { Socket } from 'dgram';
import os from 'os';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const MAX_AGE_SECONDS = 1800;
const ANNOUNCE_INTERVAL_MS = 300_000;

export interface SsdpConfig {
  uuid: string;
  /** LAN address the device is reachable on. */
  interfaceAddress: string;
  /** Absolute device description URL. */
  location: string;
  server: string;
}

interface SsdpTarget {
  /** Notification Type / Search Target. */
  nt: string;
  /** Unique Service Name. */
  usn: string;
}

function buildTargets(uuid: string): SsdpTarget[] {
  const udn = `uuid:${uuid}`;
  return [
    { nt: 'upnp:rootdevice', usn: `${udn}::upnp:rootdevice` },
    { nt: udn, usn: udn },
    { nt: 'urn:schemas-upnp-org:device:MediaRenderer:1', usn: `${udn}::urn:schemas-upnp-org:device:MediaRenderer:1` },
    { nt: 'urn:schemas-upnp-org:service:AVTransport:1', usn: `${udn}::urn:schemas-upnp-org:service:AVTransport:1` },
    { nt: 'urn:schemas-upnp-org:service:RenderingControl:1', usn: `${udn}::urn:schemas-upnp-org:service:RenderingControl:1` },
    { nt: 'urn:schemas-upnp-org:service:ConnectionManager:1', usn: `${udn}::urn:schemas-upnp-org:service:ConnectionManager:1` },
  ];
}

export class SsdpServer {
  private socket: Socket | null = null;
  private announceTimer: NodeJS.Timeout | null = null;
  private readonly targets: SsdpTarget[];

  constructor(private readonly cfg: SsdpConfig) {
    this.targets = buildTargets(cfg.uuid);
  }

  start(): void {
    if (this.socket) return;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('error', (err) => {
      console.warn('[dlna][ssdp] socket error:', err.message);
      try { socket.close(); } catch { /* already closed */ }
      this.socket = null;
    });

    socket.on('message', (msg, rinfo) => {
      this.handleMessage(msg.toString(), rinfo.address, rinfo.port);
    });

    socket.on('listening', () => {
      try {
        socket.setMulticastTTL(2);
        socket.setMulticastInterface(this.cfg.interfaceAddress);
        socket.addMembership(SSDP_ADDRESS, this.cfg.interfaceAddress);
      } catch (err) {
        console.warn('[dlna][ssdp] multicast setup failed:', err instanceof Error ? err.message : err);
      }
      this.announce('ssdp:alive');
      this.announceTimer = setInterval(() => this.announce('ssdp:alive'), ANNOUNCE_INTERVAL_MS);
    });

    try {
      socket.bind(SSDP_PORT);
    } catch (err) {
      console.warn('[dlna][ssdp] bind failed:', err instanceof Error ? err.message : err);
    }
  }

  stop(): void {
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }
    if (!this.socket) return;
    this.announce('ssdp:byebye');
    try { this.socket.close(); } catch { /* already closed */ }
    this.socket = null;
  }

  private handleMessage(message: string, address: string, port: number): void {
    const requestLine = message.split('\r\n', 1)[0] ?? '';
    if (!/^M-SEARCH\s+\*/i.test(requestLine)) return;

    const headers = parseHeaders(message);
    const st = (headers['st'] ?? '').trim();
    const man = (headers['man'] ?? '').trim();
    if (man && man !== '"ssdp:discover"') return;

    const matches = this.targets.filter((target) => st === 'ssdp:all' || st === target.nt);
    if (matches.length === 0) return;

    for (const target of matches) {
      const response = this.buildSearchResponse(target);
      try {
        this.socket?.send(response, 0, response.length, port, address);
      } catch (err) {
        console.warn('[dlna][ssdp] response send failed:', err instanceof Error ? err.message : err);
      }
    }
  }

  private buildSearchResponse(target: SsdpTarget): Buffer {
    const lines = [
      'HTTP/1.1 200 OK',
      `CACHE-CONTROL: max-age=${MAX_AGE_SECONDS}`,
      `DATE: ${new Date().toUTCString()}`,
      'EXT:',
      `LOCATION: ${this.cfg.location}`,
      `SERVER: ${this.cfg.server}`,
      `ST: ${target.nt}`,
      `USN: ${target.usn}`,
      'OPT: "http://schemas.upnp.org/upnp/1/0/"; ns=01',
      '01-NLS: 1',
      'BOOTID.UPNP.ORG: 1',
      'CONFIGID.UPNP.ORG: 1337',
      '',
      '',
    ];
    return Buffer.from(lines.join('\r\n'));
  }

  private announce(nt: 'ssdp:alive' | 'ssdp:byebye'): void {
    if (!this.socket) return;
    for (const target of this.targets) {
      const lines =
        nt === 'ssdp:alive'
          ? [
              'NOTIFY * HTTP/1.1',
              `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
              `CACHE-CONTROL: max-age=${MAX_AGE_SECONDS}`,
              `LOCATION: ${this.cfg.location}`,
              `NT: ${target.nt}`,
              'NLS: 1',
              `SERVER: ${this.cfg.server}`,
              `USN: ${target.usn}`,
              'BOOTID.UPNP.ORG: 1',
              'CONFIGID.UPNP.ORG: 1337',
              '',
              '',
            ]
          : [
              'NOTIFY * HTTP/1.1',
              `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
              `NT: ${target.nt}`,
              'NLS: 1',
              `USN: ${target.usn}`,
              'BOOTID.UPNP.ORG: 1',
              'CONFIGID.UPNP.ORG: 1337',
              '',
              '',
            ];
      const payload = Buffer.from(lines.join('\r\n'));
      try {
        this.socket.send(payload, 0, payload.length, SSDP_PORT, SSDP_ADDRESS);
      } catch (err) {
        console.warn('[dlna][ssdp] announce failed:', err instanceof Error ? err.message : err);
      }
    }
  }
}

function parseHeaders(message: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of message.split('\r\n').slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    out[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return out;
}

/** Pick the first non-internal IPv4 address, or fall back to loopback. */
export function detectInterfaceAddress(): string {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '127.0.0.1';
}