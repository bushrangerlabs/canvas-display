/**
 * Music Assistant Volume Slider — sets the configured MA player's volume.
 */

import { Slider } from '@mui/material';
import React, { useEffect, useRef, useState } from 'react';
import { useVisibility } from '../../../hooks/useVisibility';
import { useResolvedUniversalStyle } from '../../../hooks/useResolvedUniversalStyle';
import type { WidgetProps } from '../../types/index';
import { applyUniversalStyles } from '../../utils/styleBuilder';
import { MA_ACCENT, useMaControl, useMaPlayerId, useMaPlayerState } from './maSource';

const MaVolumeSliderWidget: React.FC<WidgetProps> = ({ config, isEditMode }) => {
  const cfg = config.config ?? {};
  const width = config.position?.width ?? cfg.width ?? 280;
  const height = config.position?.height ?? cfg.height ?? 70;
  const backgroundColor = cfg.backgroundColor ?? '#12161f';
  const textColor = cfg.textColor ?? '#e6edf3';
  const accentColor = cfg.accentColor ?? MA_ACCENT;
  const borderRadius = cfg.borderRadius ?? 12;
  const label = cfg.label ?? 'Volume';
  const showValue = cfg.showValue !== false;
  const showMute = cfg.showMute !== false;
  const orientation = cfg.orientation === 'vertical' ? 'vertical' : 'horizontal';
  const trackColor = cfg.trackColor ?? '#424242';
  const fillColor = cfg.fillColor ?? accentColor;
  const thumbColor = cfg.thumbColor ?? accentColor;
  const pollMs = Math.max(2, Number(cfg.pollInterval ?? 5)) * 1000;

  const isVisible = useVisibility(cfg.visibilityCondition);
  const playerId = useMaPlayerId(cfg.playerId, pollMs);
  const { player } = useMaPlayerState(playerId, pollMs);
  const control = useMaControl(playerId);
  const universalStyle = useResolvedUniversalStyle(config.config.style);

  const volume = player?.volume ?? 0;
  const muted = !!player?.muted;
  const [local, setLocal] = useState(volume);
  const dragging = useRef(false);

  // Follow the polled volume unless the user is mid-drag.
  useEffect(() => {
    if (!dragging.current) setLocal(volume);
  }, [volume]);

  if (!isVisible) return null;

  const commit = (value: number) => {
    dragging.current = false;
    void control.setVolume(value);
  };

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
    gap: 6,
  });

  return (
    <div style={containerStyle}>
      <div style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ color: textColor, fontSize: 12, fontWeight: 500 }}>{label}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {showValue && <span style={{ color: textColor, fontSize: 12, fontWeight: 700 }}>{Math.round(local)}</span>}
          {showMute && (
            <button
              type="button"
              aria-label={muted ? 'Unmute' : 'Mute'}
              disabled={isEditMode}
              onClick={() => void control.setMuted(!muted)}
              style={{
                background: 'none',
                border: 'none',
                cursor: isEditMode ? 'default' : 'pointer',
                fontSize: 14,
                padding: 0,
                lineHeight: 1,
                opacity: muted ? 1 : 0.7,
              }}
            >
              {muted ? '🔇' : '🔊'}
            </button>
          )}
        </div>
      </div>
      <div style={{ flex: 1, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Slider
          orientation={orientation}
          value={local}
          min={0}
          max={100}
          step={1}
          disabled={isEditMode}
          onChange={(_e, v) => {
            dragging.current = true;
            setLocal(v as number);
          }}
          onChangeCommitted={(_e, v) => commit(v as number)}
          sx={{
            color: fillColor,
            ...(orientation === 'vertical' ? { height: '100%' } : { width: '100%' }),
            '& .MuiSlider-track': { backgroundColor: fillColor, border: 'none' },
            '& .MuiSlider-rail': { backgroundColor: trackColor },
            '& .MuiSlider-thumb': {
              backgroundColor: thumbColor,
              '&:hover': { boxShadow: `0 0 0 8px ${thumbColor}33` },
            },
          }}
        />
      </div>
    </div>
  );
};

export default MaVolumeSliderWidget;
