/**
 * Music Assistant Radio Stations — includes the DAB+ stations exposed by the
 * user's SDR provider plugin. Tap a station to play it on the target player.
 */

import React from 'react';
import { useVisibility } from '../../../hooks/useVisibility';
import { useResolvedUniversalStyle } from '../../../hooks/useResolvedUniversalStyle';
import type { WidgetProps } from '../../types/index';
import { applyUniversalStyles } from '../../utils/styleBuilder';
import { MA_ACCENT, useMaControl, useMaPlayerId, useMaRadios } from './maSource';

const MaRadiosWidget: React.FC<WidgetProps> = ({ config, isEditMode }) => {
  const cfg = config.config ?? {};
  const width = config.position?.width ?? cfg.width ?? 300;
  const height = config.position?.height ?? cfg.height ?? 320;
  const backgroundColor = cfg.backgroundColor ?? '#12161f';
  const textColor = cfg.textColor ?? '#e6edf3';
  const accentColor = cfg.accentColor ?? MA_ACCENT;
  const borderRadius = cfg.borderRadius ?? 12;
  const showHeader = cfg.showHeader !== false;
  const filter = String(cfg.search ?? '').trim().toLowerCase();
  const maxItems = Math.max(1, Number(cfg.maxItems ?? 200));
  const pollMs = Math.max(2, Number(cfg.pollInterval ?? 30)) * 1000;

  const isVisible = useVisibility(cfg.visibilityCondition);
  const playerId = useMaPlayerId(cfg.playerId, pollMs);
  const { radios, error } = useMaRadios(pollMs);
  const control = useMaControl(playerId);
  const universalStyle = useResolvedUniversalStyle(config.config.style);

  if (!isVisible) return null;

  const visible = (filter ? radios.filter((radio) => radio.name.toLowerCase().includes(filter)) : radios).slice(0, maxItems);

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

  return (
    <div style={containerStyle}>
      {showHeader && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16, color: accentColor }}>📻</span>
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
            {cfg.title || 'Radio'}
          </div>
          <span style={{ color: textColor, fontSize: 10, opacity: 0.5 }}>{visible.length}</span>
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {visible.length === 0 && (
          <div style={{ color: textColor, fontSize: 11, opacity: 0.5 }}>No radio stations found</div>
        )}
        {visible.map((radio) => (
          <button
            key={radio.uri}
            type="button"
            disabled={isEditMode}
            onClick={() => void control.play(radio.uri)}
            style={{
              textAlign: 'left',
              background: 'rgba(255,255,255,0.06)',
              border: 'none',
              color: textColor,
              cursor: isEditMode ? 'default' : 'pointer',
              fontSize: 12,
              padding: '6px 8px',
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            {radio.artwork ? (
              <img src={radio.artwork} alt="" style={{ width: 20, height: 20, borderRadius: 4, objectFit: 'cover', flexShrink: 0 }} />
            ) : (
              <span style={{ fontSize: 12, opacity: 0.5, flexShrink: 0 }}>📻</span>
            )}
            <span style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{radio.name}</span>
          </button>
        ))}
      </div>
      {error && <div style={{ color: '#f85149', fontSize: 10 }}>{error}</div>}
    </div>
  );
};

export default MaRadiosWidget;
