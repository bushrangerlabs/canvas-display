/**
 * Music Assistant Players — whole-home player overview. Each row shows a
 * player's state and tapping it toggles play/pause on that player.
 */

import React from 'react';
import { useVisibility } from '../../../hooks/useVisibility';
import { useResolvedUniversalStyle } from '../../../hooks/useResolvedUniversalStyle';
import type { WidgetProps } from '../../types/index';
import { applyUniversalStyles } from '../../utils/styleBuilder';
import { MA_ACCENT, useMaControl, useMaPlayers } from './maSource';

const MaPlayersWidget: React.FC<WidgetProps> = ({ config, isEditMode }) => {
  const cfg = config.config ?? {};
  const width = config.position?.width ?? cfg.width ?? 300;
  const height = config.position?.height ?? cfg.height ?? 300;
  const backgroundColor = cfg.backgroundColor ?? '#12161f';
  const textColor = cfg.textColor ?? '#e6edf3';
  const accentColor = cfg.accentColor ?? MA_ACCENT;
  const borderRadius = cfg.borderRadius ?? 12;
  const showHeader = cfg.showHeader !== false;
  const maxItems = Math.max(1, Number(cfg.maxItems ?? 50));
  const pollMs = Math.max(2, Number(cfg.pollInterval ?? 10)) * 1000;
  const rowHeight = Math.max(28, Number(cfg.rowHeight ?? 48));
  const iconSize = Math.max(14, Number(cfg.iconSize ?? 28));
  const fontSize = Math.max(8, Number(cfg.fontSize ?? 12));

  const isVisible = useVisibility(cfg.visibilityCondition);
  const { players, error } = useMaPlayers(pollMs);
  const control = useMaControl('');
  const universalStyle = useResolvedUniversalStyle(config.config.style);

  if (!isVisible) return null;

  const containerStyle = applyUniversalStyles(universalStyle, {
    width,
    height,
    backgroundColor,
    borderRadius,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    boxSizing: 'border-box',
    padding: 12,
    gap: 8,
  });

  const visible = players.slice(0, maxItems);

  return (
    <div style={containerStyle}>
      {showHeader && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16, color: accentColor }}>🔊</span>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              color: textColor,
              fontSize: 12,
              fontWeight: 600,
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
            }}
          >
            {cfg.title || 'Players'}
          </div>
          <span style={{ color: textColor, fontSize: 10, opacity: 0.5 }}>{visible.length}</span>
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {visible.length === 0 && (
          <div style={{ color: textColor, fontSize: 11, opacity: 0.5 }}>
            No Music Assistant players found
          </div>
        )}
        {visible.map((player) => {
          const playing = player.state === 'playing';
          return (
            <button
              key={player.id}
              type="button"
              disabled={isEditMode || !player.available}
              onClick={() => void control.playPause(player.id)}
              style={{
                textAlign: 'left',
                background: playing ? `${accentColor}22` : 'rgba(255,255,255,0.06)',
                border: 'none',
                color: textColor,
                cursor: isEditMode ? 'default' : 'pointer',
                fontSize,
                minHeight: rowHeight,
                padding: '6px 8px',
                borderRadius: 6,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                opacity: player.available ? 1 : 0.4,
              }}
              title={player.available ? undefined : 'Player unavailable'}
            >
              <span style={{ fontSize: iconSize, color: playing ? accentColor : textColor, opacity: playing ? 1 : 0.5 }}>
                {playing ? '▶' : '⏸'}
              </span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                {player.name}
              </span>
              <span style={{ opacity: 0.5, fontSize: 10, maxWidth: '40%', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                {playing ? player.title || 'Playing' : player.state}
              </span>
            </button>
          );
        })}
      </div>
      {error && <div style={{ color: '#f85149', fontSize: 10 }}>{error}</div>}
    </div>
  );
};

export default MaPlayersWidget;
