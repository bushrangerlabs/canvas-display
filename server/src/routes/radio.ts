/**
 * DAB+ radio (SDR) and Dispatcharr (IPTV) routes.
 *
 * Backs the DAB+ and Dispatcharr editor widgets and the voice paths:
 *   GET  /api/dab/stations         — DAB+ station list (from the SDR REST API)
 *   POST /api/dab/play             — tune a DAB+ station and play its Icecast stream
 *   GET  /api/dispatcharr/channels — IPTV channel list (from the Dispatcharr HDHR lineup)
 *   POST /api/dispatcharr/play     — play an IPTV channel's stream
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { playAudio } from './audio';

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

export async function radioRoutes(app: FastifyInstance): Promise<void> {
  const sdrBase = config.sdrRadioUrl.replace(/\/$/, '');
  const dispatcharrBase = config.dispatcharrUrl.replace(/\/$/, '');

  app.get('/dab/stations', async (_req, reply) => {
    try {
      const data = (await fetchJson(`${sdrBase}/api/stations`)) as { dab?: unknown[] };
      return { stations: data.dab ?? [] };
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
      const tune = await fetch(`${sdrBase}/api/tuners/${config.sdrRadioTuner}/play`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ station: station.includes(':') ? station : `dab:${station}` }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!tune.ok) {
        const detail = await tune.text().catch(() => '');
        return reply.code(502).send({ error: detail || `SDR tune failed: HTTP ${tune.status}` });
      }
      const tuned = (await tune.json().catch(() => ({}))) as { station_name?: string };
      const state = await playAudio({
        url: config.sdrRadioStreamUrl,
        title: tuned.station_name ?? station,
      });
      return { success: true, station: tuned.station_name ?? station, url: config.sdrRadioStreamUrl, state };
    } catch (err) {
      return reply.code(502).send({
        error: `DAB+ tune failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  app.get('/dispatcharr/channels', async (_req, reply) => {
    try {
      const lineup = (await fetchJson(`${dispatcharrBase}/api/hdhr/lineup.json`)) as Array<{
        GuideNumber?: string;
        GuideName?: string;
        URL?: string;
      }>;
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
    let url = (req.body?.url ?? '').trim();
    if (!url) {
      if (!name) return reply.code(400).send({ error: 'channel or url is required' });
      try {
        const lineup = (await fetchJson(`${dispatcharrBase}/api/hdhr/lineup.json`)) as Array<{
          GuideName?: string;
          URL?: string;
        }>;
        const needle = name.toLowerCase();
        const match =
          lineup.find((channel) => (channel.GuideName ?? '').toLowerCase() === needle) ??
          lineup.find((channel) => (channel.GuideName ?? '').toLowerCase().includes(needle));
        if (!match?.URL) return reply.code(404).send({ error: `Channel "${name}" not found` });
        url = match.URL;
      } catch (err) {
        return reply.code(502).send({
          error: `Dispatcharr unavailable: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    try {
      const state = await playAudio({ url, title: name || url });
      return { success: true, channel: name, url, state };
    } catch (err) {
      return reply.code(502).send({
        error: `Dispatcharr play failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}
