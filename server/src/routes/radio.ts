/**
 * DAB+ radio (SDR) and Dispatcharr (IPTV) routes.
 *
 * Backs the DAB+ and Dispatcharr editor widgets and the voice paths:
 *   GET  /api/dab/stations         — DAB+ station list (from the SDR REST API)
 *   POST /api/dab/play             — tune a DAB+ station and play its Icecast stream
 *   GET  /api/dispatcharr/channels — IPTV channel list (from the Dispatcharr HDHR lineup)
 *   POST /api/dispatcharr/play     — play an IPTV channel's stream
 *
 * `stepRadio()` is also exported so /api/media/control can implement
 * next/previous for these sources (used by voice and MQTT).
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { getAudioState, playAudio, type AudioState } from './audio';

export type RadioSource = 'dab' | 'dispatcharr';

interface RadioItem {
  name: string;
  url?: string;
}

async function fetchJson(url: string, timeoutMs = 8000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function sdrBase(): string {
  return config.sdrRadioUrl.replace(/\/$/, '');
}

function dispatcharrBase(): string {
  return config.dispatcharrUrl.replace(/\/$/, '');
}

// The Dispatcharr lineup can hold tens of thousands of channels, so cache the
// lists briefly. This keeps the picker's polling and next/previous stepping
// from re-fetching the full lineup on every request.
const LIST_CACHE_TTL_MS = 10_000;

interface CacheEntry<T> {
  at: number;
  data: T;
}

type DabStation = { id?: string; name?: string; city?: string };
type DispatcharrChannel = { GuideNumber?: string; GuideName?: string; URL?: string };

let dabStationsCache: CacheEntry<DabStation[]> | null = null;
let dispatcharrChannelsCache: CacheEntry<DispatcharrChannel[]> | null = null;

async function fetchDabStations(): Promise<DabStation[]> {
  const now = Date.now();
  if (dabStationsCache && now - dabStationsCache.at < LIST_CACHE_TTL_MS) return dabStationsCache.data;
  const data = (await fetchJson(`${sdrBase()}/api/stations`)) as { dab?: DabStation[] };
  const stations = data.dab ?? [];
  dabStationsCache = { at: now, data: stations };
  return stations;
}

async function fetchDispatcharrChannels(): Promise<DispatcharrChannel[]> {
  const now = Date.now();
  if (dispatcharrChannelsCache && now - dispatcharrChannelsCache.at < LIST_CACHE_TTL_MS) {
    return dispatcharrChannelsCache.data;
  }
  const channels = (await fetchJson(`${dispatcharrBase()}/api/hdhr/lineup.json`)) as DispatcharrChannel[];
  dispatcharrChannelsCache = { at: now, data: channels };
  return channels;
}

/** Tune a DAB+ station on the SDR tuner and play its Icecast stream. */
async function playDabStation(station: string): Promise<AudioState> {
  const tune = await fetch(`${sdrBase()}/api/tuners/${config.sdrRadioTuner}/play`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ station: station.includes(':') ? station : `dab:${station}` }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!tune.ok) {
    const detail = await tune.text().catch(() => '');
    throw new Error(detail || `SDR tune failed: HTTP ${tune.status}`);
  }
  const tuned = (await tune.json().catch(() => ({}))) as { station_name?: string };
  return playAudio({
    url: config.sdrRadioStreamUrl,
    title: tuned.station_name ?? station,
    source: 'dab',
  });
}

/** Play a Dispatcharr channel, resolving its stream URL from the lineup if needed. */
async function playDispatcharrChannel(name: string, url?: string): Promise<AudioState> {
  let streamUrl = (url ?? '').trim();
  if (!streamUrl) {
    if (!name) throw new Error('channel or url is required');
    const lineup = await fetchDispatcharrChannels();
    const needle = name.toLowerCase();
    const match =
      lineup.find((channel) => (channel.GuideName ?? '').toLowerCase() === needle) ??
      lineup.find((channel) => (channel.GuideName ?? '').toLowerCase().includes(needle));
    if (!match?.URL) throw new Error(`Channel "${name}" not found`);
    streamUrl = match.URL;
  }
  return playAudio({ url: streamUrl, title: name || streamUrl, source: 'dispatcharr', video: true });
}

/**
 * Resolve the next/previous item for a radio source and play it.
 * The current item is matched against the audio title (exact, then substring).
 */
export async function stepRadio(source: RadioSource, direction: 1 | -1): Promise<AudioState> {
  const items: RadioItem[] =
    source === 'dab'
      ? (await fetchDabStations()).map((station) => ({ name: String(station?.name ?? station?.id ?? '') }))
      : (await fetchDispatcharrChannels()).map((channel) => ({
          name: String(channel?.GuideName ?? ''),
          url: channel?.URL,
        }));

  const playable = items.filter((item) => item.name.trim().length > 0);
  if (playable.length === 0) throw new Error('No items available');

  const current = getAudioState().title.trim().toLowerCase();
  let index = current ? playable.findIndex((item) => item.name.trim().toLowerCase() === current) : -1;
  if (index === -1 && current) {
    index = playable.findIndex((item) => {
      const name = item.name.trim().toLowerCase();
      return name.includes(current) || current.includes(name);
    });
  }

  const target =
    index === -1
      ? direction === 1
        ? 0
        : playable.length - 1
      : (index + direction + playable.length) % playable.length;

  const item = playable[target];
  return source === 'dab' ? playDabStation(item.name) : playDispatcharrChannel(item.name, item.url);
}

export async function radioRoutes(app: FastifyInstance): Promise<void> {
  app.get('/dab/stations', async (_req, reply) => {
    try {
      return { stations: await fetchDabStations() };
    } catch (err) {
      return reply.code(502).send({
        error: `SDR radio unavailable: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  app.post<{ Body: { station?: string } }>('/dab/play', async (req, reply) => {
    const station = (req.body?.station ?? '').trim();
    if (!station) return reply.code(400).send({ error: 'station is required' });
    try {
      const state = await playDabStation(station);
      return { success: true, station: state.title, url: state.url, state };
    } catch (err) {
      return reply.code(502).send({
        error: `DAB+ tune failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  app.get('/dispatcharr/channels', async (_req, reply) => {
    try {
      const lineup = await fetchDispatcharrChannels();
      return {
        channels: lineup.map((channel) => ({
          number: channel.GuideNumber,
          name: channel.GuideName,
          url: channel.URL,
        })),
      };
    } catch (err) {
      return reply.code(502).send({
        error: `Dispatcharr unavailable: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  app.post<{ Body: { channel?: string; url?: string } }>('/dispatcharr/play', async (req, reply) => {
    const name = (req.body?.channel ?? '').trim();
    const url = (req.body?.url ?? '').trim();
    if (!name && !url) return reply.code(400).send({ error: 'channel or url is required' });
    try {
      const state = await playDispatcharrChannel(name, url);
      return { success: true, channel: name, url: state.url, state };
    } catch (err) {
      return reply.code(502).send({
        error: `Dispatcharr play failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}
