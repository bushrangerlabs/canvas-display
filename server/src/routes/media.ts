import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { config } from '../config';
import { getDb } from '../db/index';
import { broadcast } from '../ws/index';
import {
  getAudioState,
  pauseAudio,
  playAudio,
  resumeAudio,
  setAudioMute,
  setAudioVolume,
  setAudioStateField,
  stopAudio,
} from './audio';
import {
  buildYouTubePlayerHtml,
  buildYouTubeWatchUrl,
  extractYouTubeVideoId,
  extractYouTubePlaylistId,
  normalizeYouTubeQuery,
  resolveYouTubeQueue,
  searchYouTubePlaylists,
  validateYouTubeVideoId,
  YouTubeApiError,
  type YouTubeSafeSearch,
} from '../services/youtube';

type MediaSourceType = 'music_assistant' | 'radio_browser' | 'direct_audio' | 'youtube';

type MediaAction = 'play' | 'pause' | 'resume' | 'stop' | 'next' | 'volume' | 'mute';

type AudioState = {
  state: string;
  title: string;
  url: string;
  volume: number;
  muted: boolean;
  artwork?: string;
};

type HomeAssistantRequestConfig = {
  baseUrl: string;
  token: string;
};

let cachedHomeAssistantAccessToken: { token: string; expiresAt: number } | null = null;
let cachedCanvasMediaPlayerEntityId: { entityId: string; expiresAt: number } | null = null;

type YouTubePlaybackStatus = {
  playback_id: string;
  status: string;
  video_id: string;
  candidate_index: number;
  candidate_count: number;
  error_code: number | null;
  query: string;
  playlist: boolean;
  playlist_id: string | null;
  updated_at: string;
};

let youtubePlaybackStatus: YouTubePlaybackStatus = {
  playback_id: '',
  status: 'idle',
  video_id: '',
  candidate_index: 0,
  candidate_count: 0,
  error_code: null,
  query: '',
  playlist: false,
  playlist_id: null,
  updated_at: new Date().toISOString(),
};
let youtubePlaybackCandidateIds: string[] = [];

type RadioBrowserStation = {
  name?: string;
  url_resolved?: string;
  url?: string;
  favicon?: string;
  homepage?: string;
  stationuuid?: string;
  tags?: string;
  countrycode?: string;
};

type ResolvedRadioStation = {
  provider: 'listnr' | 'radio_browser' | 'direct_url';
  query: string;
  name: string;
  streamUrl: string;
  artwork: string;
  homepage: string;
  stationId: string;
  tags: string;
  countryCode: string;
};

const LISTNR_DEFAULT_LOGO = 'https://www.listnr.com/favicon/android-chrome-192x192.png';
const LISTNR_DEFAULT_HOMEPAGE = 'https://www.listnr.com/live';
const LISTNR_ALIAS_TO_CALLSIGN: Record<string, string> = {
  'triple m melbourne': '3mmm',
  'triple m adelaide': '5mmm',
  'triple m perth': '6ppm',
  'fox fm': '3fox',
  '2day fm': '2day',
  'b105': '4bbb',
  'mix 94 5': '6mix',
  'mix 945': '6mix',
  'safm': '5ssa',
};
const LISTNR_PREFERRED_HOSTS = [
  'sa47.scastream.com.au',
  'sa46.scastream.com.au',
  'wz0liw.scahw.com.au',
  'wz0lia.scahw.com.au',
];

interface MediaPlayBody {
  source?: MediaSourceType;
  url?: string;
  title?: string;
  volume?: number;
  panel_id?: string;
  choose_playlist?: boolean;
  selection_position?: number;
  selection_action?: 'more';
  playlist_layout?: PlaylistWidgetLayout[];
  playlist_scene_id?: string;
}

type PlaylistWidgetLayout = {
  slot: number; x: number; y: number; w: number; h: number;
  layout?: 'artwork-above' | 'artwork-left' | 'artwork-background' | 'compact';
  backgroundColor?: string; textColor?: string; metadataColor?: string; accentColor?: string;
  borderColor?: string; borderWidth?: number; borderRadius?: number; titleWeight?: string;
  showChannel?: boolean; showItemCount?: boolean;
};

interface MediaControlBody {
  source?: MediaSourceType;
  action?: MediaAction;
  level?: number;
  muted?: boolean;
}

type PendingPlaylistSelection = {
  id: string;
  query: string;
  choices: Awaited<ReturnType<typeof searchYouTubePlaylists>>;
  offset: number;
  expiresAt: number;
  layouts: PlaylistWidgetLayout[];
};

let pendingPlaylistSelection: PendingPlaylistSelection | null = null;
const PLAYLIST_SELECTION_TTL_MS = 2 * 60_000;

function escapePlaylistHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

function cleanPlaylistDisplayText(value: string): string {
  return value
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\u200d\ufe0e\ufe0f]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildPlaylistSelectionHtml(selection: PendingPlaylistSelection): string {
  const pageSize = selection.layouts.length || 3;
  const visible = selection.choices.slice(selection.offset, selection.offset + pageSize);
  const custom = selection.layouts.length > 0;
  const cards = visible.map((choice, index) => {
    const layout = selection.layouts[index];
    const style = layout ? `left:${layout.x}%;top:${layout.y}%;width:${layout.w}%;height:${layout.h}%;--card-bg:${escapePlaylistHtml(layout.backgroundColor ?? '#151b27')};--title:${escapePlaylistHtml(layout.textColor ?? '#fff')};--meta:${escapePlaylistHtml(layout.metadataColor ?? '#b9c2d0')};--accent:${escapePlaylistHtml(layout.accentColor ?? '#287bd1')};--border:${escapePlaylistHtml(layout.borderColor ?? '#39465d')};--bw:${Math.max(0, Number(layout.borderWidth ?? 2))}px;--radius:${Math.max(0, Number(layout.borderRadius ?? 22))}px;--weight:${escapePlaylistHtml(layout.titleWeight ?? '600')}` : '';
    const cardClass = layout?.layout ?? 'artwork-above';
    const number = layout?.slot ?? index + 1;
    const metadata = `${layout?.showChannel === false ? '' : escapePlaylistHtml(cleanPlaylistDisplayText(choice.channelTitle))}${layout?.showChannel !== false && layout?.showItemCount !== false ? ' · ' : ''}${layout?.showItemCount === false ? '' : `${choice.itemCount} items`}`;
    return `<button class="choice ${cardClass}${custom ? ' custom-choice' : ''}" style="${style}" data-index="${selection.offset + index}">
      <span class="artwork">${choice.thumbnailUrl
        ? `<img src="${escapePlaylistHtml(choice.thumbnailUrl)}" alt="" loading="eager" referrerpolicy="no-referrer">`
        : '<span class="artwork-fallback">♪</span>'}</span>
      <span class="number">${number}</span>
      <span class="details"><strong>${escapePlaylistHtml(cleanPlaylistDisplayText(choice.title))}</strong><small>${metadata}</small></span>
    </button>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Choose a playlist</title><style>
  *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;background:#090b10;color:#fff;font:500 20px system-ui,sans-serif}
  body{position:relative;padding:42px 74px;display:flex;flex-direction:column;gap:16px;overflow:hidden;background:radial-gradient(circle at 50% -30%,#18243a 0,#090b10 48%)}
  .heading{position:relative;z-index:10;max-width:65%;pointer-events:none}.heading h1{margin:0;font-size:42px;line-height:1.1;letter-spacing:-.02em}.heading p{margin:10px 0 0;color:#9faabd;font-size:19px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .choices{display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:minmax(0,1fr);gap:22px;flex:1;min-height:0}.choice{min-height:0;display:flex;flex-direction:column;justify-content:flex-start;gap:14px;padding:18px;border:2px solid #39465d;border-radius:22px;background:#151b27;color:#fff;text-align:left;cursor:pointer;overflow:hidden}
  .choice:focus,.choice:hover{border-color:#70b7ff;background:#202b3d;outline:none}.number{display:grid;place-items:center;width:54px;height:54px;border-radius:50%;background:#287bd1;font-size:28px;font-weight:800}
  .artwork{display:grid;place-items:center;width:100%;aspect-ratio:16/9;max-height:300px;overflow:hidden;border-radius:14px;background:#0b0e14;flex:0 0 auto}.artwork img{width:100%;height:100%;object-fit:cover}.artwork-fallback{font-size:72px;color:#65728a}
  .details{display:flex;min-width:0;flex:1;flex-direction:column;justify-content:center;gap:14px}.details strong{font-size:clamp(22px,1.55vw,30px);line-height:1.18;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}.details small{font-size:17px;color:#b9c2d0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .actions{position:fixed;right:74px;top:46px;z-index:20;display:flex;gap:12px}.actions button{padding:12px 20px;border:1px solid #53627a;border-radius:12px;background:#182131;color:#fff;font:600 17px system-ui,sans-serif;cursor:pointer}.actions button:hover,.actions button:focus{border-color:#70b7ff;background:#25344b;outline:none}
  .custom-choices{position:absolute;inset:0}.custom-choice{position:absolute;background:var(--card-bg);color:var(--title);border-color:var(--border);border-width:var(--bw);border-radius:var(--radius);padding:clamp(8px,1.5vw,22px);gap:clamp(8px,1.2vw,18px)}.custom-choice .details strong{font-weight:var(--weight)}.custom-choice .details small{color:var(--meta)}.custom-choice .number{background:var(--accent)}
  .artwork-left{flex-direction:row;align-items:center}.artwork-left .artwork{width:42%;height:100%;aspect-ratio:auto}.artwork-background .artwork{position:absolute;inset:0;max-height:none;border-radius:inherit}.artwork-background:after{content:'';position:absolute;inset:25% 0 0;background:linear-gradient(transparent,rgba(0,0,0,.92))}.artwork-background .number,.artwork-background .details{position:relative;z-index:1;align-self:flex-end}.compact{flex-direction:row;align-items:center}.compact .artwork{width:28%;aspect-ratio:1/1}.compact .details strong{-webkit-line-clamp:2}
  </style></head><body><header class="heading"><h1>Choose a playlist</h1><p>${escapePlaylistHtml(cleanPlaylistDisplayText(selection.query))} · Tap a choice or say its number</p></header>
  <div class="choices${custom ? ' custom-choices' : ''}">${cards}</div><div class="actions"><button id="more">More results</button><button id="cancel">Cancel</button></div>
  <script>const selectionId=${JSON.stringify(selection.id)};
  async function select(body){await fetch('/api/media/youtube/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({selection_id:selectionId},body))});}
  document.querySelectorAll('.choice').forEach(b=>b.onclick=()=>select({index:Number(b.dataset.index)}));
  document.getElementById('more').onclick=()=>select({action:'more'});document.getElementById('cancel').onclick=()=>select({action:'cancel'});
  </script></body></html>`;
}

type SavedRadioStation = {
  id: string;
  name: string;
  query: string;
  source: string;
  provider: string;
  stream_url: string;
  artwork: string;
  homepage: string;
  tags: string;
  country: string;
  enabled: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

interface SaveRadioStationBody {
  query?: string;
  name?: string;
  source?: MediaSourceType;
  stream_url?: string;
  artwork?: string;
  homepage?: string;
  enabled?: boolean;
  sort_order?: number;
}

interface UpdateRadioStationBody {
  name?: string;
  query?: string;
  stream_url?: string;
  artwork?: string;
  homepage?: string;
  enabled?: boolean;
  sort_order?: number;
}



function isLikelyWebUrl(value: string | undefined): boolean {
  if (!value) return false;
  const candidate = value.trim();
  if (!candidate || /\s/.test(candidate)) return false;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isLikelyAudioStreamUrl(value: string | undefined): boolean {
  if (!value) return false;
  const candidate = value.trim().toLowerCase();
  if (!candidate) return false;

  // Common direct stream formats and URL patterns.
  if (/\.(m3u8|m3u|mp3|aac|ogg|opus|flac|pls)(\?|$)/i.test(candidate)) return true;
  if (/\/(live|stream|radio)\b/i.test(candidate)) return true;
  if (/\b(stream|icecast|shoutcast)\b/i.test(candidate)) return true;

  return false;
}

function buildLookupFromWebUrl(value: string): string {
  try {
    const parsed = new URL(value);
    const hostBits = parsed.hostname.toLowerCase().split('.').filter(Boolean);
    const coreHost = hostBits.length >= 2 ? hostBits[hostBits.length - 2] : hostBits[0] ?? '';
    const hostText = coreHost.replace(/[^a-z0-9]+/gi, ' ').trim();
    const pathText = parsed.pathname
      .split('/')
      .filter(Boolean)
      .slice(0, 2)
      .join(' ')
      .replace(/[^a-z0-9]+/gi, ' ')
      .trim();
    return normalizeLookupText(`${hostText} ${pathText}`.trim());
  } catch {
    return '';
  }
}

function normalizeLookupText(value: string | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ');
}

function normalizeStationAliasKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function buildListnrCallsignCandidates(query: string): string[] {
  const out = new Set<string>();
  const normalized = normalizeStationAliasKey(query);
  const compact = normalized.replace(/\s+/g, '');

  const aliasHit = LISTNR_ALIAS_TO_CALLSIGN[normalized];
  if (aliasHit) out.add(aliasHit);

  const compactCallsignMatch = compact.match(/\b\d{1,2}[a-z]{2,4}\b/i);
  if (compactCallsignMatch) out.add(compactCallsignMatch[0].toLowerCase());

  const spacedCallsignMatch = normalized.match(/\b(\d{1,2})\s*([a-z]{2,4})\b/i);
  if (spacedCallsignMatch) out.add(`${spacedCallsignMatch[1]}${spacedCallsignMatch[2]}`.toLowerCase());

  return Array.from(out);
}

function titleFromCallsign(callsign: string): string {
  if (!callsign) return 'LiSTNR Radio';
  return callsign.toUpperCase();
}

async function resolveListnrStation(query: string): Promise<ResolvedRadioStation | null> {
  const cleaned = normalizeLookupText(query);
  if (!cleaned) return null;

  const callsigns = buildListnrCallsignCandidates(cleaned);
  if (callsigns.length === 0) return null;

  for (const callsign of callsigns) {
    for (const bitrate of [128, 32]) {
      for (const host of LISTNR_PREFERRED_HOSTS) {
        const streamUrl = `https://${host}/live/${callsign}_${bitrate}.stream/playlist.m3u8`;
        if (!(await isResolvableStreamUrl(streamUrl))) continue;

        return {
          provider: 'listnr',
          query: cleaned,
          name: titleFromCallsign(callsign),
          streamUrl,
          artwork: LISTNR_DEFAULT_LOGO,
          homepage: LISTNR_DEFAULT_HOMEPAGE,
          stationId: callsign,
          tags: 'listnr',
          countryCode: 'AU',
        };
      }
    }
  }

  return null;
}

async function resolveRadioStation(query: string): Promise<ResolvedRadioStation | null> {
  const cleaned = normalizeLookupText(query);
  if (!cleaned) return null;

  if (isLikelyWebUrl(cleaned)) {
    return {
      provider: 'direct_url',
      query: cleaned,
      name: cleaned,
      streamUrl: cleaned,
      artwork: '',
      homepage: '',
      stationId: '',
      tags: '',
      countryCode: '',
    };
  }

  const radioBrowserStation = await resolveRadioBrowserStation(cleaned);
  const listnrStation = await resolveListnrStation(cleaned);

  if (listnrStation) {
    const callsignMeta = listnrStation.stationId ? await resolveRadioBrowserStation(listnrStation.stationId) : null;
    const meta = radioBrowserStation ?? callsignMeta;
    return {
      ...listnrStation,
      name: meta?.name?.trim() || listnrStation.name,
      artwork: meta?.favicon?.trim() || listnrStation.artwork,
      homepage: meta?.homepage?.trim() || listnrStation.homepage,
      stationId: meta?.stationuuid?.trim() || listnrStation.stationId,
      tags: meta?.tags?.trim() || listnrStation.tags,
      countryCode: meta?.countrycode?.trim() || listnrStation.countryCode,
    };
  }

  if (!radioBrowserStation) return null;

  const streamUrl = radioBrowserStation.url_resolved?.trim() || radioBrowserStation.url?.trim() || '';
  if (!streamUrl) return null;

  return {
    provider: 'radio_browser',
    query: cleaned,
    name: radioBrowserStation.name?.trim() || cleaned,
    streamUrl,
    artwork: radioBrowserStation.favicon?.trim() || '',
    homepage: radioBrowserStation.homepage?.trim() || '',
    stationId: radioBrowserStation.stationuuid?.trim() || '',
    tags: radioBrowserStation.tags?.trim() || '',
    countryCode: radioBrowserStation.countrycode?.trim() || '',
  };
}

async function isResolvableStreamUrl(value: string): Promise<boolean> {
  try {
    const parsed = new URL(value);
    if (!parsed.hostname) return false;
    await Promise.race([
      dns.lookup(parsed.hostname),
      new Promise((_, reject) => setTimeout(() => reject(new Error('dns-timeout')), 1500)),
    ]);
    return true;
  } catch {
    return false;
  }
}

function getSetting(key: string, fallback = ''): string {
  try {
    const row = getDb().prepare('SELECT value FROM server_settings WHERE key = ?').get(key) as { value?: string } | undefined;
    return (row?.value ?? fallback).trim();
  } catch {
    return fallback;
  }
}

function getYouTubeSearchOptions() {
  const configuredSafeSearch = getSetting('youtube_safe_search', config.youtubeSafeSearch);
  const safeSearch: YouTubeSafeSearch = configuredSafeSearch === 'none' || configuredSafeSearch === 'moderate'
    ? configuredSafeSearch
    : 'strict';

  return {
    apiKey: config.youtubeApiKey || getSetting('youtube_api_key'),
    regionCode: getSetting('youtube_region_code') || config.youtubeRegionCode,
    relevanceLanguage: getSetting('youtube_relevance_language') || config.youtubeRelevanceLanguage,
    allowYtDlpFallback: true,
    safeSearch,
  };
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  return normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '::ffff:127.0.0.1';
}

function getYouTubePlayerBaseUrl(): URL {
  try {
    const base = new URL(config.youtubePlayerOrigin);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
      throw new Error('unsupported player origin');
    }
    base.search = '';
    base.hash = '';
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    return base;
  } catch {
    return new URL('http://127.0.0.1:3100/');
  }
}

function mapSavedStationRow(row: SavedRadioStation) {
  return {
    id: row.id,
    name: row.name,
    query: row.query,
    source: row.source,
    provider: row.provider,
    streamUrl: row.stream_url,
    artwork: row.artwork,
    homepage: row.homepage,
    tags: row.tags,
    countryCode: row.country,
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listSavedRadioStations() {
  const rows = getDb()
    .prepare('SELECT * FROM radio_stations ORDER BY enabled DESC, sort_order ASC, name COLLATE NOCASE ASC')
    .all() as SavedRadioStation[];

  return rows.map(mapSavedStationRow);
}

function getSavedRadioStationById(id: string) {
  const row = getDb().prepare('SELECT * FROM radio_stations WHERE id = ?').get(id) as SavedRadioStation | undefined;
  return row ? mapSavedStationRow(row) : null;
}

async function probeStreamUrlHealth(streamUrl: string): Promise<{
  ok: boolean;
  dnsOk: boolean;
  httpOk: boolean;
  statusCode: number | null;
  error: string | null;
}> {
  try {
    const parsed = new URL(streamUrl);
    if (!parsed.hostname) {
      return { ok: false, dnsOk: false, httpOk: false, statusCode: null, error: 'missing-hostname' };
    }

    try {
      await Promise.race([
        dns.lookup(parsed.hostname),
        new Promise((_, reject) => setTimeout(() => reject(new Error('dns-timeout')), 1500)),
      ]);
    } catch (err) {
      return {
        ok: false,
        dnsOk: false,
        httpOk: false,
        statusCode: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4000);
    try {
      const res = await fetch(streamUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'canvas-display/1.0',
          Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,audio/*,*/*',
          Range: 'bytes=0-1024',
        },
        signal: ac.signal,
      });
      clearTimeout(timer);

      const httpOk = res.status >= 200 && res.status < 400;
      try {
        await res.body?.cancel();
      } catch {
        // ignore stream close issues
      }

      return {
        ok: httpOk,
        dnsOk: true,
        httpOk,
        statusCode: res.status,
        error: httpOk ? null : `HTTP ${res.status}`,
      };
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        dnsOk: true,
        httpOk: false,
        statusCode: null,
        error: message,
      };
    }
  } catch (err) {
    return {
      ok: false,
      dnsOk: false,
      httpOk: false,
      statusCode: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function playResolvedStation(station: ResolvedRadioStation, volume?: number, source: MediaSourceType = 'radio_browser') {
  if (!(await isResolvableStreamUrl(station.streamUrl))) {
    return {
      ok: false as const,
      status: 502,
      body: {
        error: `Radio stream host could not be resolved for "${station.query}"`,
        url: station.streamUrl,
      },
    };
  }

  const state = await playAudio({
    url: station.streamUrl,
    title: station.name,
    volume,
  });

  setAudioStateField('artwork', station.artwork || '');
  await pushRadioOverlayPageIfConfigured();

  return {
    ok: true as const,
    status: 200,
    body: {
      success: true,
      source,
      backend: 'mpv',
      provider: station.provider,
      station: station.name || null,
      artwork: station.artwork || null,
      homepage: station.homepage || null,
      url: station.streamUrl,
      state,
    },
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildRadioNowPlayingHtml(audio: AudioState): string {
  const title = escapeHtml(audio.title || 'Radio');
  const streamUrl = escapeHtml(audio.url || '');
  const artwork = escapeHtml(audio.artwork || '');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Radio Now Playing</title>
  <style>
    :root {
      color-scheme: dark;
      --bg-a: #0b1421;
      --bg-b: #16314a;
      --fg: #f3f6f9;
      --muted: #b8c5d1;
      --card: rgba(8, 14, 24, 0.55);
      --stroke: rgba(255, 255, 255, 0.18);
    }
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
    body {
      display: grid;
      place-items: center;
      font-family: "Segoe UI", "Noto Sans", sans-serif;
      color: var(--fg);
      background: radial-gradient(120% 120% at 15% 10%, #25506d 0%, var(--bg-b) 35%, var(--bg-a) 100%);
    }
    .card {
      width: min(92vw, 760px);
      height: min(92vh, 430px);
      padding: 28px;
      border-radius: 24px;
      background: var(--card);
      border: 1px solid var(--stroke);
      box-shadow: 0 20px 80px rgba(0, 0, 0, 0.38);
      backdrop-filter: blur(10px);
      display: grid;
      grid-template-columns: 180px 1fr;
      gap: 24px;
      align-items: center;
    }
    .logo-wrap {
      width: 180px;
      height: 180px;
      border-radius: 20px;
      border: 1px solid var(--stroke);
      background: rgba(10, 18, 30, 0.62);
      display: grid;
      place-items: center;
      overflow: hidden;
    }
    .logo-wrap img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      padding: 14px;
      box-sizing: border-box;
    }
    .placeholder {
      font-size: 64px;
      line-height: 1;
      opacity: 0.8;
    }
    h1 {
      margin: 0;
      font-size: clamp(28px, 4vw, 48px);
      line-height: 1.1;
      letter-spacing: 0.01em;
    }
    .meta {
      margin-top: 12px;
      font-size: clamp(14px, 1.7vw, 18px);
      color: var(--muted);
      word-break: break-word;
    }
    .badge {
      display: inline-block;
      margin-bottom: 12px;
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #d5f3ff;
      background: rgba(15, 90, 122, 0.45);
      border: 1px solid rgba(118, 219, 255, 0.45);
    }
    @media (max-width: 720px) {
      .card {
        width: 95vw;
        height: auto;
        grid-template-columns: 1fr;
        text-align: center;
        padding: 20px;
      }
      .logo-wrap {
        margin: 0 auto;
        width: 150px;
        height: 150px;
      }
    }
  </style>
</head>
<body>
  <article class="card">
    <div class="logo-wrap" id="logoWrap">
      ${artwork ? `<img id="logo" src="${artwork}" alt="Station logo" referrerpolicy="no-referrer" />` : '<div class="placeholder">📻</div>'}
    </div>
    <div>
      <div class="badge">On Air</div>
      <h1 id="title">${title}</h1>
      <div class="meta" id="url">${streamUrl}</div>
    </div>
  </article>

  <script>
    const titleEl = document.getElementById('title');
    const urlEl = document.getElementById('url');
    const logoWrap = document.getElementById('logoWrap');

    function renderLogo(url) {
      if (!url) {
        logoWrap.innerHTML = '<div class="placeholder">📻</div>';
        return;
      }
      logoWrap.innerHTML = '<img id="logo" alt="Station logo" referrerpolicy="no-referrer" />';
      const logo = document.getElementById('logo');
      logo.src = url;
      logo.onerror = () => {
        logoWrap.innerHTML = '<div class="placeholder">📻</div>';
      };
    }

    async function refresh() {
      try {
        const res = await fetch('/api/media/state', { cache: 'no-store' });
        if (!res.ok) return;
        const payload = await res.json();
        const audio = payload?.audio ?? {};
        titleEl.textContent = audio.title || 'Radio';
        urlEl.textContent = audio.url || '';
        renderLogo(audio.artwork || '');
      } catch {
        // keep last known view
      }
    }

    setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}

function getPageWithPanels(pageId: string): { id: string; floating_config: unknown; panels: Array<{ id: string }> } | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId) as { id: string; floating_config?: string | null } | undefined;
  if (!row) return null;
  const panels = db.prepare('SELECT * FROM page_panels WHERE page_id = ? ORDER BY position, id').all(pageId) as Array<{ id: string }>;
  return {
    ...row,
    floating_config: row.floating_config ? JSON.parse(row.floating_config) : null,
    panels,
  };
}

async function pushRadioOverlayPageIfConfigured(): Promise<void> {
  const enabled = getSetting('radio_overlay_enabled', '0') === '1';
  const autoshow = getSetting('radio_overlay_autoshow', '1') !== '0';
  const pageId = getSetting('radio_overlay_page_id');
  if (!enabled || !autoshow || !pageId) return;

  const page = getPageWithPanels(pageId);
  if (!page) return;

  const activePageId = getSetting('active_page_id');
  if (activePageId !== page.id) {
    const db = getDb();
    db.prepare(
      "INSERT INTO server_settings (key, value, updated_at) VALUES ('active_page_id', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run(page.id);

    broadcast({ type: 'load_page', page_id: page.id, page_data: page }, 'browser');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const requestedPanelId = getSetting('radio_overlay_panel_id');
  const panelId = requestedPanelId || page.panels[0]?.id;
  if (!panelId) return;

  const overlayUrl = `http://127.0.0.1:${config.port}/api/media/radio/now-playing.html`;
  broadcast({
    type: 'command',
    action: 'navigate_panel',
    payload: { panel_id: panelId, url: overlayUrl },
  }, 'browser');
}

function buildRadioLookupVariants(query: string): string[] {
  const base = normalizeLookupText(query);
  if (!base) return [];

  const variants = new Set<string>();
  const add = (value: string) => {
    const normalized = normalizeLookupText(value);
    if (normalized) variants.add(normalized);
  };

  add(base);
  add(base.replace(/\bradio\b/gi, ''));

  // Spoken frequencies can arrive as "11.16"; also search compact "1116" forms.
  const noDotsBetweenDigits = base.replace(/(?<=\d)\.(?=\d)/g, '');
  add(noDotsBetweenDigits);
  add(noDotsBetweenDigits.replace(/\bradio\b/gi, ''));

  const compact = noDotsBetweenDigits.replace(/\s+/g, '');
  if (/\d{3,4}[a-z]{2,4}/i.test(compact)) {
    add(compact.replace(/(\d{3,4})([a-z]{2,4})/i, '$1 $2'));
    add(compact.replace(/(\d{3,4})([a-z]{2,4})/i, '$2 $1'));
  }

  return Array.from(variants);
}

function requestJson(urlValue: string, timeoutMs = 12000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const target = new URL(urlValue);
    const client = target.protocol === 'https:' ? https : http;

    const req = client.request(
      target,
      {
        method: 'GET',
        family: 4,
        headers: {
          'User-Agent': 'canvas-display/1.0',
          Accept: 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          if (settled) return;
          settled = true;

          const status = res.statusCode ?? 0;
          const body = Buffer.concat(chunks).toString('utf8');
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status}`));
            return;
          }
          try {
            resolve(body ? JSON.parse(body) : null);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      },
    );

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    req.setTimeout(timeoutMs, () => {
      if (settled) return;
      settled = true;
      req.destroy(new Error('Request timeout'));
    });

    req.end();
  });
}

async function resolveHomeAssistantAccessToken(homeAssistantBaseUrl: string): Promise<string | null> {
  const staticToken = config.homeAssistantToken.trim();
  if (staticToken) return staticToken;

  const refreshToken = config.homeAssistantRefreshToken.trim();
  if (!refreshToken) return null;

  const now = Date.now();
  if (cachedHomeAssistantAccessToken && cachedHomeAssistantAccessToken.expiresAt > now + 30_000) {
    return cachedHomeAssistantAccessToken.token;
  }

  const payload = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.homeAssistantClientId.trim() || 'http://canvas-display.local/',
    refresh_token: refreshToken,
  });

  const tokenEndpoint = `${homeAssistantBaseUrl.replace(/\/api$/i, '')}/auth/token`;
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: payload.toString(),
  });

  if (!res.ok) {
    throw new Error(`HA auth token exchange failed → ${res.status}`);
  }

  const body = await res.json() as { access_token?: string; expires_in?: number };
  const token = (body.access_token ?? '').trim();
  if (!token) {
    throw new Error('HA auth token exchange returned no access_token');
  }

  const ttlMs = Math.max(60, body.expires_in ?? 1800) * 1000;
  cachedHomeAssistantAccessToken = {
    token,
    expiresAt: now + ttlMs,
  };
  return token;
}

async function getHomeAssistantRequestConfig(): Promise<HomeAssistantRequestConfig | null> {
  if (config.haSupervisorToken) {
    return {
      baseUrl: 'http://supervisor/core/api',
      token: config.haSupervisorToken,
    };
  }

  const url = config.homeAssistantUrl.trim().replace(/\/$/, '');
  if (!url) return null;

  const token = await resolveHomeAssistantAccessToken(`${url}/api`);
  if (!token) return null;

  return {
    baseUrl: `${url}/api`,
    token,
  };
}

async function homeAssistantFetchJson<T>(path: string): Promise<T> {
  const requestConfig = await getHomeAssistantRequestConfig();
  if (!requestConfig) throw new Error('Home Assistant API credentials are not configured');
  const res = await fetch(`${requestConfig.baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${requestConfig.token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`HA API ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function homeAssistantPostJson<T>(path: string, body: unknown): Promise<T> {
  const requestConfig = await getHomeAssistantRequestConfig();
  if (!requestConfig) throw new Error('Home Assistant API credentials are not configured');
  const res = await fetch(`${requestConfig.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requestConfig.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HA API POST ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

function getConfiguredDeviceName(): string {
  try {
    const row = getDb().prepare("SELECT value FROM server_settings WHERE key='device_name'").get() as { value?: string } | undefined;
    return (row?.value ?? '').trim();
  } catch {
    return '';
  }
}

async function findCanvasMediaPlayerEntityId(): Promise<string | null> {
  const configured = config.canvasMediaPlayerEntityId.trim();
  if (configured) return configured;

  const now = Date.now();
  if (cachedCanvasMediaPlayerEntityId && cachedCanvasMediaPlayerEntityId.expiresAt > now) {
    return cachedCanvasMediaPlayerEntityId.entityId;
  }

  const deviceName = getConfiguredDeviceName().toLowerCase();

  try {
    const states = await homeAssistantFetchJson<Array<{ entity_id?: string; attributes?: { friendly_name?: string } }>>('/states');
    const mediaPlayers = states.filter((state) => (state.entity_id ?? '').startsWith('media_player.'));

    const exactDeviceMatch = mediaPlayers.find((state) => {
      const friendlyName = (state.attributes?.friendly_name ?? '').trim().toLowerCase();
      return !!deviceName && friendlyName === deviceName;
    });
    if (exactDeviceMatch?.entity_id) {
      cachedCanvasMediaPlayerEntityId = {
        entityId: exactDeviceMatch.entity_id,
        expiresAt: now + 60_000,
      };
      return exactDeviceMatch.entity_id;
    }

    const entityMatch = mediaPlayers.find((state) => {
      const entityId = (state.entity_id ?? '').toLowerCase();
      const friendlyName = (state.attributes?.friendly_name ?? '').toLowerCase();
      if (deviceName && (entityId.includes(deviceName.replace(/\s+/g, '_')) || friendlyName.includes(deviceName))) {
        return true;
      }
      return entityId.includes('canvas') || friendlyName.includes('canvas');
    });
    const resolved = entityMatch?.entity_id ?? null;
    if (resolved) {
      cachedCanvasMediaPlayerEntityId = {
        entityId: resolved,
        expiresAt: now + 60_000,
      };
    }
    return resolved;
  } catch {
    return null;
  }
}

function mapHomeAssistantPlayerToAudioState(state: {
  state?: string;
  attributes?: {
    media_title?: string;
    media_content_id?: string;
    volume_level?: number;
    is_volume_muted?: boolean;
  };
}): AudioState {
  const raw = (state.state ?? '').toLowerCase();
  const mappedState = raw === 'playing'
    ? 'playing'
    : raw === 'paused'
      ? 'paused'
      : 'idle';
  const attrs = state.attributes ?? {};

  return {
    state: mappedState,
    title: (attrs.media_title ?? '').toString(),
    url: (attrs.media_content_id ?? '').toString(),
    volume: Math.max(0, Math.min(100, Math.round((attrs.volume_level ?? 0.75) * 100))),
    muted: Boolean(attrs.is_volume_muted ?? false),
  };
}

async function getMusicAssistantAudioState(): Promise<AudioState | null> {
  const entityId = await findCanvasMediaPlayerEntityId();
  if (!entityId) return null;
  try {
    const state = await homeAssistantFetchJson<{
      state?: string;
      attributes?: {
        media_title?: string;
        media_content_id?: string;
        volume_level?: number;
        is_volume_muted?: boolean;
      };
    }>(`/states/${entityId}`);
    return mapHomeAssistantPlayerToAudioState(state);
  } catch {
    cachedCanvasMediaPlayerEntityId = null;
    return null;
  }
}

async function resolveRadioBrowserStation(query: string): Promise<RadioBrowserStation | null> {
  const cleaned = normalizeLookupText(query);
  if (!cleaned) return null;
  const failures: string[] = [];

  const baseUrls = [
    'https://de1.api.radio-browser.info',
    'https://fr1.api.radio-browser.info',
    'http://de1.api.radio-browser.info',
  ];

  const lookupVariants = buildRadioLookupVariants(cleaned);
  const endpoints: URL[] = [];

  for (const lookup of lookupVariants) {
    for (const base of baseUrls) {
      const byName = new URL(`${base}/json/stations/search`);
      byName.searchParams.set('name', lookup);
      endpoints.push(byName);

      const byTag = new URL(`${base}/json/stations/search`);
      byTag.searchParams.set('tag', lookup);
      endpoints.push(byTag);

      const byNamePath = new URL(`${base}/json/stations/byname/${encodeURIComponent(lookup)}`);
      endpoints.push(byNamePath);
    }
  }

  const maxConcurrency = 3;
  let nextIndex = 0;
  let resolvedStation: RadioBrowserStation | null = null;

  const worker = async () => {
    while (nextIndex < endpoints.length && !resolvedStation) {
      const endpoint = endpoints[nextIndex++];
      endpoint.searchParams.set('hidebroken', 'true');
      endpoint.searchParams.set('order', 'clickcount');
      endpoint.searchParams.set('reverse', 'true');
      endpoint.searchParams.set('limit', '15');

      try {
        const stations = await requestJson(endpoint.toString(), 3500) as RadioBrowserStation[];
        if (!Array.isArray(stations)) {
          failures.push(`${endpoint.origin}${endpoint.pathname} -> invalid_payload`);
          continue;
        }
        const station = stations.find((item) => (item.url_resolved ?? item.url ?? '').trim()) ?? stations[0];
        if (station) {
          resolvedStation = station;
          return;
        }
        failures.push(`${endpoint.origin}${endpoint.pathname} -> empty`);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        failures.push(`${endpoint.origin}${endpoint.pathname} -> request_failed:${detail}`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(maxConcurrency, endpoints.length) }, () => worker()));

  if (resolvedStation) return resolvedStation;

  if (failures.length > 0) {
    console.warn('[media] Radio Browser lookup failed', { query: cleaned, variants: lookupVariants, failures });
  }

  return null;
}

export async function mediaRoutes(app: FastifyInstance) {
  app.get('/media/radio/stations', async () => {
    return {
      success: true,
      stations: listSavedRadioStations(),
    };
  });

  app.get<{ Params: { id: string } }>('/media/radio/stations/:id', async (req, reply) => {
    const station = getSavedRadioStationById(req.params.id);
    if (!station) return reply.code(404).send({ error: 'Station not found' });
    return { success: true, station };
  });

  app.get<{ Querystring: { enabledOnly?: string } }>('/media/radio/stations/verify', async (req) => {
    const enabledOnly = req.query?.enabledOnly === '1';
    const stations = listSavedRadioStations().filter((station) => (enabledOnly ? station.enabled : true));
    const results: Array<{
      id: string;
      name: string;
      streamUrl: string;
      ok: boolean;
      dnsOk: boolean;
      httpOk: boolean;
      statusCode: number | null;
      error: string | null;
      checkedAt: string;
    }> = [];

    const maxConcurrency = 4;
    let index = 0;
    const worker = async () => {
      while (index < stations.length) {
        const station = stations[index++];
        const health = await probeStreamUrlHealth(station.streamUrl);
        results.push({
          id: station.id,
          name: station.name,
          streamUrl: station.streamUrl,
          ok: health.ok,
          dnsOk: health.dnsOk,
          httpOk: health.httpOk,
          statusCode: health.statusCode,
          error: health.error,
          checkedAt: new Date().toISOString(),
        });
      }
    };

    await Promise.all(Array.from({ length: Math.min(maxConcurrency, stations.length || 1) }, () => worker()));

    return {
      success: true,
      count: results.length,
      healthy: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      results,
    };
  });

  app.post<{ Body: SaveRadioStationBody }>('/media/radio/stations', async (req, reply) => {
    const body = req.body ?? {};
    const source = body.source ?? 'radio_browser';
    const query = normalizeLookupText(body.query ?? body.name ?? body.stream_url);
    if (!query) return reply.code(400).send({ error: 'query is required' });

    let resolved: ResolvedRadioStation | null = null;
    if (body.stream_url?.trim()) {
      resolved = {
        provider: 'direct_url',
        query,
        name: body.name?.trim() || query,
        streamUrl: body.stream_url.trim(),
        artwork: body.artwork?.trim() || '',
        homepage: body.homepage?.trim() || '',
        stationId: '',
        tags: '',
        countryCode: '',
      };
    } else {
      resolved = await resolveRadioStation(query);
    }

    if (!resolved) {
      return reply.code(404).send({ error: `No station found for "${query}"` });
    }

    if (!(await isResolvableStreamUrl(resolved.streamUrl))) {
      return reply.code(502).send({
        error: `Radio stream host could not be resolved for "${query}"`,
        url: resolved.streamUrl,
      });
    }

    const id = randomUUID();
    const enabled = body.enabled === undefined ? 1 : (body.enabled ? 1 : 0);
    const sortOrder = Number.isFinite(body.sort_order) ? Number(body.sort_order) : 0;
    const name = body.name?.trim() || resolved.name || query;

    getDb().prepare(
      `INSERT INTO radio_stations
        (id, name, query, source, provider, stream_url, artwork, homepage, tags, country, enabled, sort_order, created_at, updated_at)
       VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run(
      id,
      name,
      query,
      source,
      resolved.provider,
      resolved.streamUrl,
      body.artwork?.trim() || resolved.artwork || '',
      body.homepage?.trim() || resolved.homepage || '',
      resolved.tags || '',
      resolved.countryCode || '',
      enabled,
      sortOrder,
    );

    const saved = getSavedRadioStationById(id);
    return reply.code(201).send({ success: true, station: saved });
  });

  app.patch<{ Params: { id: string }; Body: UpdateRadioStationBody }>('/media/radio/stations/:id', async (req, reply) => {
    const id = req.params.id;
    const existing = getSavedRadioStationById(id);
    if (!existing) return reply.code(404).send({ error: 'Station not found' });

    const body = req.body ?? {};

    const nextName = body.name?.trim() ?? existing.name;
    const nextQuery = normalizeLookupText(body.query ?? existing.query);
    const nextStreamUrl = body.stream_url?.trim() ?? existing.streamUrl;
    const nextArtwork = body.artwork?.trim() ?? existing.artwork;
    const nextHomepage = body.homepage?.trim() ?? existing.homepage;
    const nextEnabled = body.enabled === undefined ? (existing.enabled ? 1 : 0) : (body.enabled ? 1 : 0);
    const nextSort = body.sort_order === undefined ? existing.sortOrder : Number(body.sort_order);

    if (!nextName || !nextQuery || !nextStreamUrl) {
      return reply.code(400).send({ error: 'name, query, and stream_url must be non-empty' });
    }

    getDb().prepare(
      `UPDATE radio_stations
          SET name = ?, query = ?, stream_url = ?, artwork = ?, homepage = ?, enabled = ?, sort_order = ?, updated_at = datetime('now')
        WHERE id = ?`,
    ).run(nextName, nextQuery, nextStreamUrl, nextArtwork, nextHomepage, nextEnabled, nextSort, id);

    return { success: true, station: getSavedRadioStationById(id) };
  });

  app.delete<{ Params: { id: string } }>('/media/radio/stations/:id', async (req, reply) => {
    const id = req.params.id;
    const row = getDb().prepare('DELETE FROM radio_stations WHERE id = ?').run(id);
    if (!row.changes) return reply.code(404).send({ error: 'Station not found' });
    return { success: true };
  });

  app.post<{ Params: { id: string }; Body: { volume?: number } }>('/media/radio/stations/:id/play', async (req, reply) => {
    const id = req.params.id;
    const saved = getSavedRadioStationById(id);
    if (!saved) return reply.code(404).send({ error: 'Station not found' });

    // Enforce single-station behavior: stop any current local stream first.
    await stopAudio().catch(() => undefined);

    const resolved: ResolvedRadioStation = {
      provider: (saved.provider as ResolvedRadioStation['provider']) || 'direct_url',
      query: saved.query,
      name: saved.name,
      streamUrl: saved.streamUrl,
      artwork: saved.artwork,
      homepage: saved.homepage,
      stationId: '',
      tags: saved.tags,
      countryCode: saved.countryCode,
    };

    try {
      const playback = await playResolvedStation(resolved, req.body?.volume, 'radio_browser');
      if (!playback.ok) return reply.code(playback.status).send(playback.body);
      return playback.body;
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  app.get<{ Querystring: { query?: string } }>('/media/radio/lookup', async (req, reply) => {
    const query = normalizeLookupText(req.query?.query);
    if (!query) return reply.code(400).send({ error: 'query is required' });

    const station = await resolveRadioStation(query);
    if (!station) {
      return reply.code(404).send({ error: `No station found for "${query}"` });
    }

    if (!(await isResolvableStreamUrl(station.streamUrl))) {
      return reply.code(502).send({
        error: `Radio stream host could not be resolved for "${query}"`,
        url: station.streamUrl,
      });
    }

    return {
      success: true,
      station,
    };
  });

  app.get('/media/radio/now-playing.html', async (_req, reply) => {
    const audio = getAudioState();
    reply.header('Cache-Control', 'no-store');
    reply.type('text/html; charset=utf-8');
    return buildRadioNowPlayingHtml(audio);
  });

  app.get('/media/state', async () => {
    const musicAssistantState = await getMusicAssistantAudioState();
    if (musicAssistantState) {
      return {
        audio: musicAssistantState,
        source: 'music_assistant',
      };
    }
    return {
      audio: getAudioState(),
      source: 'direct_audio',
    };
  });

  app.get<{
    Params: { videoId: string };
    Querystring: { fallback?: string; playback_id?: string; playlist?: string };
  }>('/media/youtube/player/:videoId', async (req, reply) => {
    const videoId = validateYouTubeVideoId(req.params.videoId);
    if (!videoId) return reply.code(400).send({ error: 'Invalid YouTube video id' });

    const fallbackIds = (req.query?.fallback ?? '')
      .split(',')
      .map((candidate) => validateYouTubeVideoId(candidate))
      .filter((candidate): candidate is string => Boolean(candidate));
    const playbackId = /^[A-Za-z0-9_-]{1,80}$/.test(req.query?.playback_id ?? '')
      ? req.query.playback_id ?? ''
      : '';

    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'autoplay=(self "https://www.youtube.com")');
    reply.type('text/html; charset=utf-8');
    return buildYouTubePlayerHtml([videoId, ...fallbackIds], playbackId, req.query?.playlist === '1');
  });

  app.get('/media/youtube/status', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return youtubePlaybackStatus;
  });

  app.post<{
    Body: {
      playback_id?: string;
      event?: string;
      video_id?: string;
      candidate_index?: number;
      candidate_count?: number;
      error_code?: number;
      previous_error_code?: number;
    };
  }>('/media/youtube/player-event', async (req, reply) => {
    const body = req.body ?? {};
    const event = (body.event ?? '').trim();
    const allowedEvents = new Set([
      'ready',
      'playing',
      'ended',
      'candidate_error',
      'candidate_switch',
      'exhausted',
      'identity_error',
      'player_error',
      'autoplay_blocked',
      'paused',
      'resumed',
      'stopped',
      'next_unavailable',
    ]);
    if (!allowedEvents.has(event)) return reply.code(400).send({ error: 'Invalid YouTube player event' });

    const playbackId = (body.playback_id ?? '').trim();
    const videoId = validateYouTubeVideoId(body.video_id) ?? '';
    const candidateIndex = Number(body.candidate_index);
    const candidateCount = Number(body.candidate_count);
    const validCandidateContext = Number.isInteger(candidateIndex)
      && Number.isInteger(candidateCount)
      && candidateIndex >= 0
      && candidateCount === youtubePlaybackStatus.candidate_count
      && candidateIndex < candidateCount
      && youtubePlaybackCandidateIds[candidateIndex] === videoId;
    const eventMatchesCurrentPlayback = Boolean(
      playbackId
      && videoId
      && validCandidateContext
      && youtubePlaybackStatus.playback_id
      && playbackId === youtubePlaybackStatus.playback_id,
    );

    if (eventMatchesCurrentPlayback) {
      const reportedErrorCode = body.error_code ?? body.previous_error_code;
      const errorCode = Number.isFinite(reportedErrorCode) ? Number(reportedErrorCode) : null;
      youtubePlaybackStatus = {
        ...youtubePlaybackStatus,
        playback_id: playbackId || youtubePlaybackStatus.playback_id,
        status: event,
        video_id: videoId || youtubePlaybackStatus.video_id,
        candidate_index: candidateIndex,
        candidate_count: candidateCount,
        error_code: errorCode,
        updated_at: new Date().toISOString(),
      };
    }

    console.log('[youtube:player] Event:', {
      playbackId: playbackId || null,
      event,
      videoId: videoId || null,
      candidateIndex: body.candidate_index ?? null,
      candidateCount: body.candidate_count ?? null,
      errorCode: body.error_code ?? body.previous_error_code ?? null,
      stale: !eventMatchesCurrentPlayback,
    });
    return { ok: true };
  });

  app.get<{ Params: { selectionId: string } }>('/media/youtube/choose/:selectionId', async (req, reply) => {
    const selection = pendingPlaylistSelection;
    if (!selection || selection.id !== req.params.selectionId || selection.expiresAt <= Date.now()) {
      pendingPlaylistSelection = null;
      return reply.code(404).type('text/html').send('<h1>Playlist selection expired</h1>');
    }
    reply.header('Cache-Control', 'no-store');
    return reply.type('text/html; charset=utf-8').send(buildPlaylistSelectionHtml(selection));
  });

  app.get<{ Params: { selectionId: string } }>('/media/youtube/selection/:selectionId', async (req, reply) => {
    const selection = pendingPlaylistSelection;
    if (!selection || selection.id !== req.params.selectionId || selection.expiresAt <= Date.now()) {
      pendingPlaylistSelection = null;
      return reply.code(404).send({ ok: false, error: 'playlist_selection_expired' });
    }
    const pageSize = selection.layouts.length || 3;
    const choices = selection.choices
      .slice(selection.offset, selection.offset + pageSize)
      .map((choice, index) => ({
        selection_index: selection.offset + index,
        display_number: selection.layouts[index]?.slot ?? index + 1,
        playlist_id: choice.playlistId,
        title: choice.title,
        channel: choice.channelTitle,
        item_count: choice.itemCount,
        artwork_url: choice.thumbnailUrl,
      }));
    reply.header('Cache-Control', 'no-store');
    return { ok: true, selection_id: selection.id, query: selection.query, choices };
  });

  app.post<{
    Body: { selection_id?: string; index?: number; position?: number; action?: 'more' | 'cancel' };
  }>('/media/youtube/select', async (req, reply) => {
    const selection = pendingPlaylistSelection;
    if (!selection || (req.body?.selection_id && selection.id !== req.body.selection_id) || selection.expiresAt <= Date.now()) {
      pendingPlaylistSelection = null;
      return reply.code(409).send({ ok: false, error: 'playlist_selection_expired' });
    }
    if (req.body.action === 'cancel') {
      pendingPlaylistSelection = null;
      broadcast({ type: 'command', action: 'hide_floating', payload: {} }, 'browser');
      return { ok: true, cancelled: true };
    }
    if (req.body.action === 'more') {
      const nextOffset = selection.offset + (selection.layouts.length || 3);
      selection.offset = nextOffset < selection.choices.length ? nextOffset : 0;
      selection.expiresAt = Date.now() + PLAYLIST_SELECTION_TTL_MS;
      const choiceUrl = new URL(`api/media/youtube/choose/${selection.id}`, getYouTubePlayerBaseUrl());
      choiceUrl.searchParams.set('page', String(selection.offset / 3));
      if (selection.layouts.length === 0) {
        broadcast({ type: 'command', action: 'show_floating', payload: { url: choiceUrl.toString() } }, 'browser');
      }
      return {
        ok: true, more: true, backend: 'youtube_iframe_api', url: choiceUrl.toString(),
        offset: selection.offset, visible_count: Math.min(selection.layouts.length || 3, selection.choices.length - selection.offset),
      };
    }
    const requestedIndex = Number.isInteger(req.body.index)
      ? Number(req.body.index)
      : selection.offset + Number(req.body.position);
    const choice = selection.choices[requestedIndex];
    if (!choice) return reply.code(400).send({ ok: false, error: 'invalid_playlist_selection' });
    pendingPlaylistSelection = null;
    const response = await app.inject({
      method: 'POST',
      url: '/api/media/play',
      payload: {
        source: 'youtube',
        url: `https://www.youtube.com/playlist?list=${encodeURIComponent(choice.playlistId)}`,
        title: choice.title,
      },
    });
    return reply.code(response.statusCode).headers({ 'content-type': 'application/json' }).send(response.json());
  });

  app.post<{ Body: MediaPlayBody }>('/media/play', async (req, reply) => {
    const body = req.body ?? {};
    const source: MediaSourceType = body.source ?? 'direct_audio';

    if (source === 'youtube') {
      if (Number.isInteger(body.selection_position) || body.selection_action === 'more') {
        const selectionResponse = await app.inject({
          method: 'POST',
          url: '/api/media/youtube/select',
          payload: Number.isInteger(body.selection_position)
            ? { position: body.selection_position }
            : { action: 'more' },
        });
        return reply.code(selectionResponse.statusCode).headers({ 'content-type': 'application/json' }).send(selectionResponse.json());
      }
      const target = body.url?.trim() || body.title?.trim() || '';
      if (!target) return reply.code(400).send({ error: 'url or title is required for youtube source' });

      const explicitVideoId = extractYouTubeVideoId(target);
      const query = normalizeYouTubeQuery(target) || normalizeYouTubeQuery(body.title ?? '') || '';
      const searchAllowed = config.youtubeAllowRemoteSearch || isLoopbackAddress(req.ip);
      if (query && !explicitVideoId && !searchAllowed) {
        return reply.code(403).send({
          error: 'Remote YouTube title search is disabled',
          code: 'youtube_remote_search_disabled',
          hint: 'Run the request on the kiosk server or set YOUTUBE_ALLOW_REMOTE_SEARCH=1.',
        });
      }

      const searchOptions = getYouTubeSearchOptions();
      const fallbackQuery = searchAllowed ? body.title ?? '' : '';
      if (!searchAllowed) searchOptions.apiKey = '';

      if (body.choose_playlist && !extractYouTubePlaylistId(target)) {
        const apiKey = searchOptions.apiKey.trim();
        if (!apiKey) {
          return reply.code(503).send({
            error: 'A YouTube API key is required to offer playlist choices',
            code: 'youtube_api_key_missing',
          });
        }
        const choices = await searchYouTubePlaylists(
          query || target,
          apiKey,
          searchOptions.regionCode,
          searchOptions.relevanceLanguage,
          searchOptions.safeSearch,
          fetch,
        );
        if (choices.length === 0) return reply.code(404).send({ error: 'No matching public playlists found' });
        const selection: PendingPlaylistSelection = {
          id: randomUUID(), query: query || target, choices, offset: 0,
          expiresAt: Date.now() + PLAYLIST_SELECTION_TTL_MS,
          layouts: (body.playlist_layout ?? []).slice(0, 8),
        };
        pendingPlaylistSelection = selection;
        console.log(`[youtube:playlist] selection=${selection.id} custom_slots=${selection.layouts.length}`);
        const choiceUrl = new URL(`api/media/youtube/choose/${selection.id}`, getYouTubePlayerBaseUrl()).toString();
        const sceneId = typeof body.playlist_scene_id === 'string' ? body.playlist_scene_id.trim() : '';
        const customSceneUrl = selection.layouts.length > 0 && sceneId
          ? new URL(
              `display/scenes/${encodeURIComponent(sceneId)}?playlist_selection_id=${encodeURIComponent(selection.id)}`,
              getYouTubePlayerBaseUrl(),
            ).toString()
          : '';
        // A configured playlist scene is delivered by Core after this response.
        // Only the built-in fallback uses the generated floating selection page.
        if (selection.layouts.length === 0) {
          broadcast({ type: 'command', action: 'show_floating', payload: { url: choiceUrl } }, 'browser');
        } else {
          broadcast({ type: 'command', action: 'hide_floating', payload: {} }, 'browser');
        }
        return {
          success: true,
          source,
          backend: 'youtube_iframe_api',
          selection_required: true,
          selection_id: selection.id,
          expires_in_seconds: PLAYLIST_SELECTION_TTL_MS / 1000,
          url: customSceneUrl || choiceUrl,
          choices: choices.slice(0, selection.layouts.length || 3).map((choice, index) => ({
            number: selection.layouts[index]?.slot ?? index + 1,
            playlist_id: choice.playlistId,
            title: choice.title,
            channel: choice.channelTitle,
            item_count: choice.itemCount,
          })),
        };
      }

      let queue: Awaited<ReturnType<typeof resolveYouTubeQueue>>;
      try {
        queue = await resolveYouTubeQueue(target, fallbackQuery, searchOptions);
      } catch (err) {
        if (err instanceof YouTubeApiError) {
          return reply.code(err.httpStatus).send({
            error: err.message,
            code: err.code,
            hint: err.code === 'youtube_api_key_missing'
              ? 'Configure a YouTube Data API v3 key in Settings or set YOUTUBE_API_KEY.'
              : undefined,
          });
        }
        throw err;
      }

      const candidates = queue.candidates;

      const videoId = candidates[0]?.videoId;
      if (!videoId) {
        return reply.code(404).send({ error: `No eligible YouTube video found for "${query || target}"` });
      }

      const playbackId = randomUUID();
      const playerUrl = new URL(
        `api/media/youtube/player/${encodeURIComponent(videoId)}`,
        getYouTubePlayerBaseUrl(),
      );
      const fallbackIds = candidates.slice(1).map((candidate) => candidate.videoId);
      if (fallbackIds.length > 0) playerUrl.searchParams.set('fallback', fallbackIds.join(','));
      if (queue.playlist) playerUrl.searchParams.set('playlist', '1');
      playerUrl.searchParams.set('playback_id', playbackId);
      const url = playerUrl.toString();
      const videoUrl = buildYouTubeWatchUrl(videoId, false);
      const payload: Record<string, string> = { url };
      if (body.panel_id) payload.panel_id = body.panel_id;

      youtubePlaybackCandidateIds = candidates.map((candidate) => candidate.videoId);
      youtubePlaybackStatus = {
        playback_id: playbackId,
        status: 'loading',
        video_id: videoId,
        candidate_index: 0,
        candidate_count: candidates.length,
        error_code: null,
        query,
        playlist: queue.playlist,
        playlist_id: queue.playlistId,
        updated_at: new Date().toISOString(),
      };

      if (body.panel_id) {
        broadcast({
          type: 'command',
          action: 'navigate_panel',
          payload: { panel_id: body.panel_id, url },
        }, 'browser');
      } else {
        broadcast({ type: 'command', action: 'show_floating', payload }, 'browser');
      }
      return {
        success: true,
        source,
        backend: 'youtube_iframe_api',
        url,
        video_url: videoUrl,
        video_id: videoId,
        playback_id: playbackId,
        candidate_count: candidates.length,
        playlist: queue.playlist,
        playlist_id: queue.playlistId,
        candidates: candidates.map((candidate) => ({
          video_id: candidate.videoId,
          title: candidate.title,
          channel: candidate.channelTitle,
        })),
      };
    }

    if (source === 'radio_browser') {
      const lookup = normalizeLookupText(body.url ?? body.title);
      if (!lookup) return reply.code(400).send({ error: 'url or title is required for radio_browser source' });

      // Enforce single-station behavior: stop any current local stream first.
      await stopAudio().catch(() => undefined);

      const station = await resolveRadioStation(lookup);
      if (!station) {
        return reply.code(404).send({ error: `No station found for "${lookup}"` });
      }

      try {
        const playback = await playResolvedStation(
          { ...station, name: body.title?.trim() || station.name || lookup },
          body.volume,
          source,
        );
        if (!playback.ok) return reply.code(playback.status).send(playback.body);
        return playback.body;
      } catch (err: any) {
        if (String(err?.message ?? '').includes('404')) {
          cachedCanvasMediaPlayerEntityId = null;
        }
        return reply.code(500).send({ error: err.message });
      }
    }

    if (source === 'music_assistant') {
      const lookup = normalizeLookupText(body.url ?? body.title);
      if (!lookup) return reply.code(400).send({ error: 'url or title is required for music_assistant source' });

      if (isLikelyWebUrl(lookup)) {
        try {
          const state = await playAudio({
            url: lookup,
            title: body.title,
            volume: body.volume,
          });
          return {
            success: true,
            source,
            backend: 'mpv',
            url: lookup,
            state,
          };
        } catch (err: any) {
          return reply.code(500).send({ error: err.message });
        }
      }

      const entityId = await findCanvasMediaPlayerEntityId();
      if (!entityId) {
        return reply.code(503).send({
          error: 'No Canvas Display media_player entity configured',
          hint: 'Set CANVAS_MEDIA_PLAYER_ENTITY_ID and HOME_ASSISTANT_URL/HOME_ASSISTANT_TOKEN, or run as an HA add-on with supervisor access.',
        });
      }

      try {
        await homeAssistantPostJson('/services/media_player/play_media', {
          entity_id: entityId,
          media_content_id: lookup,
          media_content_type: 'music',
        });
        return {
          success: true,
          source,
          backend: 'home-assistant',
          entity_id: entityId,
          query: lookup,
        };
      } catch (err: any) {
        if (String(err?.message ?? '').includes('404')) {
          cachedCanvasMediaPlayerEntityId = null;
        }
        return reply.code(500).send({ error: err.message });
      }
    }

    if (!body.url) return reply.code(400).send({ error: 'url is required' });

    const requestedUrl = body.url.trim();
    if (isLikelyWebUrl(requestedUrl) && !isLikelyAudioStreamUrl(requestedUrl)) {
      const lookup = normalizeLookupText(body.title) || buildLookupFromWebUrl(requestedUrl);
      if (lookup) {
        const station = await resolveRadioStation(lookup);
        if (station) {
          const playback = await playResolvedStation(
            { ...station, name: body.title?.trim() || station.name || lookup },
            body.volume,
            'radio_browser',
          );
          if (!playback.ok) return reply.code(playback.status).send(playback.body);
          return playback.body;
        }
      }

      return reply.code(400).send({
        error: 'Provided URL appears to be a webpage, not a direct audio stream',
        hint: 'Use a direct stream URL (.m3u8, .mp3, .aac) or source=radio_browser with station name.',
      });
    }

    try {
      const state = await playAudio({
        url: requestedUrl,
        title: body.title,
        volume: body.volume,
      });

      return {
        success: true,
        source,
        backend: 'mpv',
        state,
      };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  app.post<{ Body: MediaControlBody }>('/media/control', async (req, reply) => {
    const body = req.body ?? {};
    const action = body.action;
    const source: MediaSourceType = body.source ?? 'direct_audio';

    if (!action) return reply.code(400).send({ error: 'action is required' });

    if (source === 'youtube') {
      if (['pause', 'resume', 'stop', 'next'].includes(action)) {
        if (action !== 'stop' && !youtubePlaybackStatus.playback_id) {
          return reply.code(409).send({
            ok: false,
            error: 'no_active_youtube_playback',
            message: 'There is no active YouTube playback to control',
          });
        }
        broadcast({ type: 'command', action: `youtube_${action}`, payload: {} }, 'browser');
        if (action === 'stop') broadcast({ type: 'command', action: 'hide_floating', payload: {} }, 'browser');
        youtubePlaybackStatus = {
          ...youtubePlaybackStatus,
          status: action === 'resume'
            ? 'playing'
            : action === 'next'
              ? 'loading'
              : action === 'pause' ? 'paused' : 'stopped',
          error_code: null,
          updated_at: new Date().toISOString(),
        };
        if (action === 'stop') {
          pendingPlaylistSelection = null;
          youtubePlaybackCandidateIds = [];
          youtubePlaybackStatus.playback_id = '';
          youtubePlaybackStatus.playlist = false;
          youtubePlaybackStatus.playlist_id = null;
        }
        return { success: true, source, action, playback_id: youtubePlaybackStatus.playback_id };
      }

      return reply.code(400).send({ error: `action ${action} is not supported for youtube source` });
    }

    if (source === 'music_assistant') {
      const entityId = await findCanvasMediaPlayerEntityId();
      if (!entityId) {
        return reply.code(503).send({
          error: 'No Canvas Display media_player entity configured',
          hint: 'Set CANVAS_MEDIA_PLAYER_ENTITY_ID and HOME_ASSISTANT_URL/HOME_ASSISTANT_TOKEN, or run as an HA add-on with supervisor access.',
        });
      }

      try {
        if (action === 'pause') {
          try {
            await homeAssistantPostJson('/services/media_player/media_pause', { entity_id: entityId });
          } catch {
            // Some media_player implementations do not expose pause.
            await homeAssistantPostJson('/services/media_player/media_stop', { entity_id: entityId });
          }
        } else if (action === 'resume') {
          await homeAssistantPostJson('/services/media_player/media_play', { entity_id: entityId });
        } else if (action === 'stop') {
          await homeAssistantPostJson('/services/media_player/media_stop', { entity_id: entityId });
        } else if (action === 'volume') {
          if (body.level === undefined || body.level === null) {
            return reply.code(400).send({ error: 'level is required for volume action' });
          }
          const volumeLevel = Math.max(0, Math.min(100, body.level)) / 100;
          await homeAssistantPostJson('/services/media_player/volume_set', {
            entity_id: entityId,
            volume_level: volumeLevel,
          });
        } else if (action === 'mute') {
          if (body.muted === undefined) {
            return reply.code(400).send({ error: 'muted is required for mute action' });
          }
          await homeAssistantPostJson('/services/media_player/volume_mute', {
            entity_id: entityId,
            is_volume_muted: body.muted,
          });
        } else {
          return reply.code(400).send({ error: `unknown action: ${action}` });
        }

        return { success: true, source, action, backend: 'home-assistant', entity_id: entityId };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    }

    try {
      if (action === 'pause') return { success: true, source, action, state: await pauseAudio() };
      if (action === 'resume') return { success: true, source, action, state: await resumeAudio() };
      if (action === 'stop') return { success: true, source, action, state: await stopAudio() };
      if (action === 'volume') {
        if (body.level === undefined || body.level === null) {
          return reply.code(400).send({ error: 'level is required for volume action' });
        }
        return { success: true, source, action, state: await setAudioVolume(body.level) };
      }
      if (action === 'mute') {
        if (body.muted === undefined) {
          return reply.code(400).send({ error: 'muted is required for mute action' });
        }
        return { success: true, source, action, state: await setAudioMute(body.muted) };
      }

      return reply.code(400).send({ error: `unknown action: ${action}` });
    } catch (err: any) {
      if (err?.message === 'Not playing' || err?.message === 'Not paused') {
        return reply.code(409).send({ error: err.message });
      }
      return reply.code(500).send({ error: err.message });
    }
  });
}
