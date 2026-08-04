/**
 * Now Playing Widget - Music Assistant / HA media_player card
 * Shows album art, track title, artist, playback controls, and progress.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useVisibility } from '../../hooks/useVisibility';
import { useWidget } from '../hooks/useWidget';
import type { WidgetProps } from '../types/index';
import type { WidgetMetadata } from '../types/metadata';

export const NowPlayingWidgetMetadata: WidgetMetadata = {
  name: 'Now Playing',
  icon: 'MusicNote',
  category: 'media',
  description: 'Displays the current media player state — album art, title, artist, and playback controls',
  defaultSize: { w: 380, h: 140 },
  minSize: { w: 260, h: 100 },
  requiresEntity: true,
  fields: [
    { name: 'entity_id', type: 'entity', label: 'Media Player Entity', default: '', category: 'behavior', binding: true, description: 'media_player.* entity to display' },
    { name: 'showControls', type: 'checkbox', label: 'Show controls (play/pause/skip)', default: true, category: 'behavior' },
    { name: 'showProgress', type: 'checkbox', label: 'Show progress bar', default: true, category: 'behavior' },
    { name: 'backgroundColor', type: 'color', label: 'Background', default: '#1a1a2e', category: 'style' },
    { name: 'textColor', type: 'color', label: 'Text colour', default: '#ffffff', category: 'style' },
    { name: 'accentColor', type: 'color', label: 'Accent colour', default: '#4a9eff', category: 'style' },
    { name: 'borderRadius', type: 'number', label: 'Corner radius', default: 12, min: 0, max: 40, category: 'style' },
  ],
};

const NowPlayingWidget: React.FC<WidgetProps> = ({ config }) => {
  const cfg = config.config ?? {};
  const width = config.position?.width ?? cfg.width ?? 380;
  const height = config.position?.height ?? cfg.height ?? 140;
  const backgroundColor = cfg.backgroundColor ?? '#1a1a2e';
  const textColor = cfg.textColor ?? '#ffffff';
  const accentColor = cfg.accentColor ?? '#4a9eff';
  const borderRadius = cfg.borderRadius ?? 12;
  const showControls = cfg.showControls !== false;
  const showProgress = cfg.showProgress !== false;

  const isVisible = useVisibility(cfg.visibilityCondition);
  const { getEntity } = useWidget(config);
  const entity = getEntity('entity_id');

  const state: string = entity?.state ?? 'idle';
  const attrs = entity?.attributes ?? {};
  const title: string = attrs.media_title ?? attrs.media_content_id ?? '—';
  const artist: string = attrs.media_artist ?? '';
  const albumArt: string | undefined = attrs.entity_picture
    ? `/api/ha/proxy${attrs.entity_picture}`
    : undefined;
  const position: number = attrs.media_position ?? 0;
  const duration: number = attrs.media_duration ?? 0;
  const volume: number = attrs.volume_level ?? 0;
  const entityId: string = cfg.entity_id ?? '';

  // Live progress tick
  const [livePosition, setLivePosition] = useState(position);
  const posUpdatedAt = useRef<number>(Date.now());
  useEffect(() => {
    setLivePosition(position);
    posUpdatedAt.current = Date.now();
  }, [position]);
  useEffect(() => {
    if (state !== 'playing' || !duration) return;
    const id = setInterval(() => {
      const elapsed = (Date.now() - posUpdatedAt.current) / 1000;
      setLivePosition(Math.min(position + elapsed, duration));
    }, 1000);
    return () => clearInterval(id);
  }, [state, position, duration]);

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const haCall = async (service: string, extra: Record<string, unknown> = {}) => {
    await fetch(`/api/ha/services/media_player/${service}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_id: entityId, ...extra }),
    });
  };

  if (!isVisible) return null;

  const progressPct = duration > 0 ? Math.min((livePosition / duration) * 100, 100) : 0;

  return (
    <div style={{
      width, height, backgroundColor, borderRadius,
      display: 'flex', flexDirection: 'row', alignItems: 'center',
      overflow: 'hidden', boxSizing: 'border-box', padding: '10px',
      gap: 12, position: 'relative',
    }}>
      {/* Album art */}
      <div style={{
        width: height - 20, height: height - 20,
        borderRadius: 8, overflow: 'hidden', flexShrink: 0,
        backgroundColor: '#2a2a3e',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {albumArt ? (
          <img src={albumArt} alt="album art"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <span style={{ fontSize: 32, opacity: 0.3 }}>♪</span>
        )}
      </div>

      {/* Info + controls */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{
          color: textColor, fontSize: 14, fontWeight: 600,
          overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
        }}>{state === 'idle' || state === 'off' ? 'Nothing playing' : title}</div>
        {artist && (
          <div style={{
            color: textColor, fontSize: 12, opacity: 0.7,
            overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
          }}>{artist}</div>
        )}
        {showProgress && duration > 0 && (
          <div style={{ marginTop: 4 }}>
            <div style={{ height: 3, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${progressPct}%`, height: '100%', backgroundColor: accentColor, borderRadius: 2, transition: 'width 1s linear' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
              <span style={{ color: textColor, fontSize: 10, opacity: 0.6 }}>{fmt(livePosition)}</span>
              <span style={{ color: textColor, fontSize: 10, opacity: 0.6 }}>{fmt(duration)}</span>
            </div>
          </div>
        )}
        {showControls && entityId && (
          <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center' }}>
            <button onClick={() => void haCall('media_previous_track')}
              style={btnStyle(textColor)}>⏮</button>
            <button
              onClick={() => void haCall(state === 'playing' ? 'media_pause' : 'media_play')}
              style={{ ...btnStyle(textColor), backgroundColor: accentColor, color: '#fff', width: 32, height: 32, borderRadius: 16 }}>
              {state === 'playing' ? '⏸' : '▶'}
            </button>
            <button onClick={() => void haCall('media_next_track')}
              style={btnStyle(textColor)}>⏭</button>
            <div style={{ flex: 1 }} />
            <span style={{ color: textColor, fontSize: 10, opacity: 0.5 }}>
              {Math.round(volume * 100)}%
            </span>
          </div>
        )}
      </div>

      {/* State badge */}
      {(state === 'paused' || state === 'idle' || state === 'off') && (
        <div style={{
          position: 'absolute', top: 8, right: 8,
          backgroundColor: 'rgba(0,0,0,0.5)', color: textColor,
          fontSize: 9, padding: '2px 6px', borderRadius: 4, opacity: 0.6,
        }}>
          {state.toUpperCase()}
        </div>
      )}
    </div>
  );
};

function btnStyle(color: string): React.CSSProperties {
  return {
    background: 'rgba(255,255,255,0.08)',
    border: 'none',
    color,
    cursor: 'pointer',
    fontSize: 14,
    width: 28,
    height: 28,
    borderRadius: 6,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  };
}

export default NowPlayingWidget;
