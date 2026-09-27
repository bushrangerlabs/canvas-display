/**
 * Shared "now playing" display used by the DAB+ Now Playing and
 * Dispatcharr Now Playing widgets.
 */

import React from 'react';
import { useVisibility } from '../../../hooks/useVisibility';
import { useResolvedUniversalStyle } from '../../../hooks/useResolvedUniversalStyle';
import type { WidgetProps } from '../../types/index';
import { applyUniversalStyles } from '../../utils/styleBuilder';
import { defaultAccent, defaultPollSeconds, sourceLabel, useMediaAudio, type MediaKind } from './mediaSource';

const MediaNowPlaying: React.FC<WidgetProps & { kind: MediaKind }> = ({ config, kind }) => {
  const cfg = config.config ?? {};
  const width = config.position?.width ?? cfg.width ?? 340;
  const height = config.position?.height ?? cfg.height ?? 120;
  const backgroundColor = cfg.backgroundColor ?? '#12161f';
  const textColor = cfg.textColor ?? '#e6edf3';
  const accentColor = cfg.accentColor ?? defaultAccent(kind);
  const borderRadius = cfg.borderRadius ?? 12;
  const showArtwork = cfg.showArtwork !== false;
  const showState = cfg.showState !== false;
  const showSource = cfg.showSource !== false;
  const emptyText = cfg.emptyText ?? 'Nothing playing';
  const pollMs = Math.max(2, Number(cfg.pollInterval ?? defaultPollSeconds(kind))) * 1000;

  const isVisible = useVisibility(cfg.visibilityCondition);
  const { audio } = useMediaAudio(pollMs);
  const universalStyle = useResolvedUniversalStyle(config.config.style);

  if (!isVisible) return null;

  const idle = audio.state === 'idle' || !audio.title;
  const title = idle ? emptyText : audio.title;
  const rawArtwork = audio.artwork;
  const artwork = rawArtwork
    ? /^https?:\/\//i.test(rawArtwork) || rawArtwork.startsWith('data:')
      ? rawArtwork
      : `/api/ha/proxy${rawArtwork}`
    : undefined;
  const row = width >= height * 1.6;
  const artSize = Math.max(28, Math.min(row ? height - 24 : width - 24, height - 24));

  const stateColor = audio.state === 'playing' ? accentColor : audio.state === 'paused' ? '#d29922' : '#8b949e';

  const containerStyle = applyUniversalStyles(universalStyle, {
    width,
    height,
    backgroundColor,
    borderRadius,
    display: 'flex',
    flexDirection: row ? 'row' : 'column',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    boxSizing: 'border-box',
    padding: 12,
    gap: 10,
  });

  return (
    <div style={containerStyle}>
      {showArtwork && (
        <div
          style={{
            width: artSize,
            height: artSize,
            flexShrink: 0,
            borderRadius: 8,
            overflow: 'hidden',
            backgroundColor: 'rgba(255,255,255,0.06)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {artwork ? (
            <img src={artwork} alt="artwork" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <span style={{ fontSize: artSize * 0.5, color: accentColor, opacity: 0.7 }}>{kind === 'dab' ? '📻' : '📺'}</span>
          )}
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3, alignItems: row ? 'flex-start' : 'center' }}>
        <div
          style={{
            color: textColor,
            fontSize: 14,
            fontWeight: 600,
            maxWidth: '100%',
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            textAlign: row ? 'left' : 'center',
          }}
        >
          {title}
        </div>
        {showSource && (
          <div style={{ color: textColor, fontSize: 10, opacity: 0.55 }}>{sourceLabel(kind)}</div>
        )}
        {showState && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 1 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: stateColor }} />
            <span style={{ color: stateColor, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              {audio.state}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

export default MediaNowPlaying;
