/**
 * Shared preset grid used by the DAB+ Presets and Dispatcharr Presets
 * widgets. The presets shown are ticked in the inspector (checklist field).
 */

import React from 'react';
import { useVisibility } from '../../../hooks/useVisibility';
import { useResolvedUniversalStyle } from '../../../hooks/useResolvedUniversalStyle';
import type { WidgetProps } from '../../types/index';
import { applyUniversalStyles } from '../../utils/styleBuilder';
import { defaultAccent, defaultPollSeconds, useMediaAudio, useMediaPlay, type MediaKind } from './mediaSource';

const MediaPresets: React.FC<WidgetProps & { kind: MediaKind }> = ({ config, isEditMode, kind }) => {
  const cfg = config.config ?? {};
  const width = config.position?.width ?? cfg.width ?? 320;
  const height = config.position?.height ?? cfg.height ?? 130;
  const backgroundColor = cfg.backgroundColor ?? '#12161f';
  const textColor = cfg.textColor ?? '#e6edf3';
  const accentColor = cfg.accentColor ?? defaultAccent(kind);
  const borderRadius = cfg.borderRadius ?? 12;
  const columns = Math.max(1, Math.min(8, Number(cfg.columns ?? 3)));
  const showLabels = cfg.showLabels !== false;
  const buttonHeight = Math.max(24, Number(cfg.buttonHeight ?? 40));
  const pollMs = Math.max(2, Number(cfg.pollInterval ?? defaultPollSeconds(kind))) * 1000;

  const presets: string[] = Array.isArray(cfg.presets) ? cfg.presets.filter((p: unknown) => typeof p === 'string') : [];

  const isVisible = useVisibility(cfg.visibilityCondition);
  const { error, playByName } = useMediaPlay(kind);
  const { audio } = useMediaAudio(pollMs);
  const universalStyle = useResolvedUniversalStyle(config.config.style);

  if (!isVisible) return null;

  const currentTitle = audio.title.toLowerCase();
  const isActive = (name: string) => currentTitle.length > 0 && currentTitle.includes(name.toLowerCase());

  const containerStyle = applyUniversalStyles(universalStyle, {
    width,
    height,
    backgroundColor,
    borderRadius,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    boxSizing: 'border-box',
    padding: 10,
    gap: 6,
  });

  return (
    <div style={containerStyle}>
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          display: 'grid',
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gridAutoRows: `${buttonHeight}px`,
          gap: 6,
        }}
      >
        {presets.length === 0 && (
          <div style={{ color: textColor, fontSize: 11, opacity: 0.5, gridColumn: '1 / -1' }}>
            No presets selected — tick some in the inspector.
          </div>
        )}
        {presets.map((name) => {
          const active = isActive(name);
          return (
            <button
              key={name}
              type="button"
              disabled={isEditMode}
              onClick={() => void playByName(name)}
              title={name}
              style={{
                minWidth: 0,
                height: '100%',
                border: active ? `1px solid ${accentColor}` : '1px solid transparent',
                background: active ? `${accentColor}33` : 'rgba(255,255,255,0.06)',
                color: textColor,
                cursor: isEditMode ? 'default' : 'pointer',
                borderRadius: 8,
                padding: '0 8px',
                fontSize: 12,
                fontWeight: active ? 600 : 400,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                overflow: 'hidden',
              }}
            >
              {!showLabels && <span style={{ color: accentColor }}>{kind === 'dab' ? '📻' : '📺'}</span>}
              {showLabels && (
                <span style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{name}</span>
              )}
            </button>
          );
        })}
      </div>
      {error && <div style={{ color: '#f85149', fontSize: 10 }}>{error}</div>}
    </div>
  );
};

export default MediaPresets;
