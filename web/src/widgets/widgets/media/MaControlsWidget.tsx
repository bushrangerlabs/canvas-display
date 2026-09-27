/**
 * Music Assistant Controls — transport buttons for the configured MA player.
 * Which buttons appear is configurable.
 */

import React from 'react';
import { useVisibility } from '../../../hooks/useVisibility';
import { useResolvedUniversalStyle } from '../../../hooks/useResolvedUniversalStyle';
import type { WidgetProps } from '../../types/index';
import { applyUniversalStyles } from '../../utils/styleBuilder';
import { MA_ACCENT, useMaControl, useMaPlayerId, useMaPlayerState } from './maSource';

const MaControlsWidget: React.FC<WidgetProps> = ({ config, isEditMode }) => {
  const cfg = config.config ?? {};
  const width = config.position?.width ?? cfg.width ?? 280;
  const height = config.position?.height ?? cfg.height ?? 96;
  const backgroundColor = cfg.backgroundColor ?? '#12161f';
  const textColor = cfg.textColor ?? '#e6edf3';
  const accentColor = cfg.accentColor ?? MA_ACCENT;
  const borderRadius = cfg.borderRadius ?? 12;
  const showPlayPause = cfg.showPlayPause !== false;
  const showStop = cfg.showStop !== false;
  const showPrevious = cfg.showPrevious !== false;
  const showNext = cfg.showNext !== false;
  const showMute = cfg.showMute !== false;
  const showStatus = cfg.showStatus !== false;
  const buttonSize = Math.max(24, Number(cfg.buttonSize ?? 40));
  const pollMs = Math.max(2, Number(cfg.pollInterval ?? 5)) * 1000;

  const isVisible = useVisibility(cfg.visibilityCondition);
  const playerId = useMaPlayerId(cfg.playerId, pollMs);
  const { player, error } = useMaPlayerState(playerId, pollMs);
  const control = useMaControl(playerId);
  const universalStyle = useResolvedUniversalStyle(config.config.style);

  if (!isVisible) return null;

  const playing = player?.state === 'playing';
  const muted = !!player?.muted;

  const containerStyle = applyUniversalStyles(universalStyle, {
    width,
    height,
    backgroundColor,
    borderRadius,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    boxSizing: 'border-box',
    padding: 10,
    gap: 8,
  });

  const btn = (size: number, primary = false): React.CSSProperties => ({
    width: size,
    height: size,
    borderRadius: size / 2,
    border: 'none',
    cursor: isEditMode ? 'default' : 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: size * 0.42,
    lineHeight: 1,
    padding: 0,
    background: primary ? accentColor : 'rgba(255,255,255,0.08)',
    color: primary ? '#fff' : textColor,
    opacity: isEditMode ? 0.6 : 1,
  });

  return (
    <div style={containerStyle}>
      {showStatus && (
        <div
          style={{
            color: textColor,
            fontSize: 11,
            opacity: 0.7,
            maxWidth: '100%',
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
          }}
        >
          {player ? (playing ? player.title || 'Playing' : player.state) : 'No player'}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
        {showPrevious && (
          <button type="button" aria-label="Previous" disabled={isEditMode} onClick={() => void control.previous()} style={btn(buttonSize * 0.85)}>
            ⏮
          </button>
        )}
        {showPlayPause && (
          <button type="button" aria-label={playing ? 'Pause' : 'Play'} disabled={isEditMode} onClick={() => void control.playPause()} style={btn(buttonSize, true)}>
            {playing ? '⏸' : '▶'}
          </button>
        )}
        {showStop && (
          <button type="button" aria-label="Stop" disabled={isEditMode} onClick={() => void control.stop()} style={btn(buttonSize * 0.85)}>
            ⏹
          </button>
        )}
        {showNext && (
          <button type="button" aria-label="Next" disabled={isEditMode} onClick={() => void control.next()} style={btn(buttonSize * 0.85)}>
            ⏭
          </button>
        )}
        {showMute && (
          <button
            type="button"
            aria-label={muted ? 'Unmute' : 'Mute'}
            disabled={isEditMode}
            onClick={() => void control.setMuted(!muted)}
            style={{ ...btn(buttonSize * 0.85), ...(muted ? { background: accentColor, color: '#fff' } : null) }}
          >
            {muted ? '🔇' : '🔊'}
          </button>
        )}
      </div>
      {error && <div style={{ color: '#f85149', fontSize: 10 }}>{error}</div>}
    </div>
  );
};

export default MaControlsWidget;
