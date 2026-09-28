/**
 * Music Assistant Now Playing — artwork, title, artist, state and progress
 * for the configured MA player.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useVisibility } from '../../../hooks/useVisibility';
import { useResolvedUniversalStyle } from '../../../hooks/useResolvedUniversalStyle';
import type { WidgetProps } from '../../types/index';
import { applyUniversalStyles } from '../../utils/styleBuilder';
import { MA_ACCENT, formatSeconds, useMaControl, useMaPlayerId, useMaPlayerState } from './maSource';

const MaNowPlayingWidget: React.FC<WidgetProps> = ({ config, isEditMode }) => {
  const cfg = config.config ?? {};
  const width = config.position?.width ?? cfg.width ?? 360;
  const height = config.position?.height ?? cfg.height ?? 120;
  const backgroundColor = cfg.backgroundColor ?? '#12161f';
  const textColor = cfg.textColor ?? '#e6edf3';
  const accentColor = cfg.accentColor ?? MA_ACCENT;
  const borderRadius = cfg.borderRadius ?? 12;
  const showArtwork = cfg.showArtwork !== false;
  const showState = cfg.showState !== false;
  const showProgress = cfg.showProgress !== false;
  const emptyText = cfg.emptyText || 'Nothing playing';
  const pollMs = Math.max(2, Number(cfg.pollInterval ?? 5)) * 1000;

  const isVisible = useVisibility(cfg.visibilityCondition);
  const playerId = useMaPlayerId(cfg.playerId, pollMs);
  const mediaType = cfg.mediaType === 'youtube_music' ? 'youtube_music' : 'music_assistant';
  const { player, error } = useMaPlayerState(playerId, pollMs, true, mediaType);
  const control = useMaControl(playerId, mediaType);
  const universalStyle = useResolvedUniversalStyle(config.config.style);

  // Smoothly advance the progress bar between polls.
  const [elapsed, setElapsed] = useState(player?.elapsedSeconds ?? 0);
  const stampRef = useRef(Date.now());
  useEffect(() => {
    setElapsed(player?.elapsedSeconds ?? 0);
    stampRef.current = Date.now();
  }, [player?.elapsedSeconds]);
  useEffect(() => {
    if (player?.state !== 'playing' || !player.durationSeconds) return;
    const id = window.setInterval(() => {
      setElapsed((player.elapsedSeconds ?? 0) + (Date.now() - stampRef.current) / 1000);
    }, 1000);
    return () => window.clearInterval(id);
  }, [player?.state, player?.elapsedSeconds, player?.durationSeconds]);

  if (!isVisible) return null;

  const playing = player?.state === 'playing';
  const idle = !player || player.state === 'idle' || player.state === 'stopped';
  const duration = player?.durationSeconds ?? 0;
  const progress = duration > 0 ? Math.min((elapsed / duration) * 100, 100) : 0;

  const containerStyle = applyUniversalStyles(universalStyle, {
    width,
    height,
    backgroundColor,
    borderRadius,
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    overflow: 'hidden',
    boxSizing: 'border-box',
    padding: 10,
    gap: 12,
    position: 'relative',
  });

  return (
    <div style={containerStyle}>
      {showArtwork && (
        <div
          style={{
            width: height - 20,
            height: height - 20,
            borderRadius: 8,
            overflow: 'hidden',
            flexShrink: 0,
            backgroundColor: '#2a2a3e',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {player?.artwork ? (
            <img src={player.artwork} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <span style={{ fontSize: 32, opacity: 0.3 }}>♪</span>
          )}
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div
          style={{
            color: textColor,
            fontSize: 14,
            fontWeight: 600,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
          }}
        >
          {idle ? emptyText : player?.title || 'Unknown'}
        </div>
        {player?.artist && (
          <div style={{ color: textColor, fontSize: 12, opacity: 0.7, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
            {player.artist}
          </div>
        )}
        {showProgress && duration > 0 && (
          <div style={{ marginTop: 4 }}>
            <div style={{ height: 3, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${progress}%`, height: '100%', backgroundColor: accentColor, borderRadius: 2, transition: 'width 1s linear' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
              <span style={{ color: textColor, fontSize: 10, opacity: 0.6 }}>{formatSeconds(elapsed)}</span>
              <span style={{ color: textColor, fontSize: 10, opacity: 0.6 }}>{formatSeconds(duration)}</span>
            </div>
          </div>
        )}
      </div>
      {showState && !idle && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            backgroundColor: 'rgba(0,0,0,0.5)',
            color: playing ? accentColor : textColor,
            fontSize: 9,
            padding: '2px 6px',
            borderRadius: 4,
            opacity: 0.8,
            textTransform: 'uppercase',
          }}
        >
          {player?.state}
        </div>
      )}
      {!idle && (
        <button
          type="button"
          aria-label={playing ? 'Pause' : 'Play'}
          disabled={isEditMode}
          onClick={() => void control.playPause()}
          style={{
            background: accentColor,
            border: 'none',
            color: '#fff',
            cursor: isEditMode ? 'default' : 'pointer',
            fontSize: 16,
            width: 36,
            height: 36,
            borderRadius: 18,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            flexShrink: 0,
          }}
        >
          {playing ? '⏸' : '▶'}
        </button>
      )}
      {error && <div style={{ color: '#f85149', fontSize: 10, position: 'absolute', bottom: 4, left: 10 }}>{error}</div>}
    </div>
  );
};

export default MaNowPlayingWidget;
