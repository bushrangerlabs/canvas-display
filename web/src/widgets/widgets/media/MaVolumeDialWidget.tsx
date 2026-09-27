/**
 * Music Assistant Volume Dial — rotary dial that sets the configured MA
 * player's volume. Drag anywhere on the dial to change it.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useVisibility } from '../../../hooks/useVisibility';
import { useResolvedUniversalStyle } from '../../../hooks/useResolvedUniversalStyle';
import type { WidgetProps } from '../../types/index';
import { applyUniversalStyles } from '../../utils/styleBuilder';
import { MA_ACCENT, useMaControl, useMaPlayerId, useMaPlayerState } from './maSource';

const CX = 50;
const CY = 50;
const R = 38;

/** Polar → cartesian with 0° pointing up and angles increasing clockwise. */
function polar(deg: number, radius: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  return { x: CX + radius * Math.sin(rad), y: CY - radius * Math.cos(rad) };
}

function arcPath(fromDeg: number, toDeg: number, radius: number): string {
  const start = polar(fromDeg, radius);
  const end = polar(toDeg, radius);
  const largeArc = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

const MaVolumeDialWidget: React.FC<WidgetProps> = ({ config, isEditMode }) => {
  const cfg = config.config ?? {};
  const width = config.position?.width ?? cfg.width ?? 170;
  const height = config.position?.height ?? cfg.height ?? 170;
  const backgroundColor = cfg.backgroundColor ?? '#12161f';
  const textColor = cfg.textColor ?? '#e6edf3';
  const knobColor = cfg.knobColor ?? '#1f2733';
  const trackColor = cfg.trackColor ?? '#2a3444';
  const fillColor = cfg.fillColor ?? MA_ACCENT;
  const borderRadius = cfg.borderRadius ?? 12;
  const label = cfg.label ?? 'Volume';
  const showValue = cfg.showValue !== false;
  const showMute = cfg.showMute !== false;
  const angleOffset = Number(cfg.angleOffset ?? 220);
  const angleRange = Math.min(360, Math.max(30, Number(cfg.angleRange ?? 280)));
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
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!dragging.current) setLocal(volume);
  }, [volume]);

  if (!isVisible) return null;

  const start = angleOffset;
  const end = angleOffset + angleRange;
  const valueAngle = start + (Math.min(100, Math.max(0, local)) / 100) * angleRange;
  const pointer = polar(valueAngle, R - 12);
  const pointerInner = polar(valueAngle, R - 24);

  const valueFromEvent = (clientX: number, clientY: number): number | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const x = ((clientX - rect.left) / rect.width) * 100;
    const y = ((clientY - rect.top) / rect.height) * 100;
    let deg = (Math.atan2(x - CX, CY - y) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    if (deg < start) deg += 360;
    if (deg > end) {
      const gapMid = (end + (start + 360)) / 2;
      deg = deg < gapMid ? end : start;
    }
    return ((deg - start) / angleRange) * 100;
  };

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (isEditMode) return;
    const v = valueFromEvent(e.clientX, e.clientY);
    if (v === null) return;
    dragging.current = true;
    setLocal(v);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (isEditMode || !dragging.current) return;
    const v = valueFromEvent(e.clientX, e.clientY);
    if (v !== null) setLocal(v);
  };

  const handlePointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    const v = valueFromEvent(e.clientX, e.clientY);
    void control.setVolume(v ?? local);
  };

  const containerStyle = applyUniversalStyles(universalStyle, {
    width,
    height,
    backgroundColor,
    borderRadius,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    boxSizing: 'border-box',
    padding: 8,
    position: 'relative',
  });

  return (
    <div style={containerStyle}>
      <svg
        ref={svgRef}
        viewBox="0 0 100 100"
        width="100%"
        height="100%"
        style={{ touchAction: 'none', cursor: isEditMode ? 'default' : 'grab', display: 'block' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <path d={arcPath(start, end, R)} fill="none" stroke={trackColor} strokeWidth={8} strokeLinecap="round" />
        <path d={arcPath(start, valueAngle, R)} fill="none" stroke={fillColor} strokeWidth={8} strokeLinecap="round" />
        <circle cx={CX} cy={CY} r={R - 14} fill={knobColor} />
        <line
          x1={pointerInner.x}
          y1={pointerInner.y}
          x2={pointer.x}
          y2={pointer.y}
          stroke={fillColor}
          strokeWidth={4}
          strokeLinecap="round"
        />
        {showValue && (
          <text x={CX} y={CY + 2} textAnchor="middle" dominantBaseline="middle" fill={textColor} fontSize={16} fontWeight={700}>
            {Math.round(local)}
          </text>
        )}
        {label && (
          <text x={CX} y={CY + 16} textAnchor="middle" fill={textColor} fontSize={7} opacity={0.6}>
            {label}
          </text>
        )}
      </svg>
      {showMute && (
        <button
          type="button"
          aria-label={muted ? 'Unmute' : 'Mute'}
          disabled={isEditMode}
          onClick={() => void control.setMuted(!muted)}
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            background: 'none',
            border: 'none',
            cursor: isEditMode ? 'default' : 'pointer',
            fontSize: 13,
            padding: 0,
            lineHeight: 1,
            opacity: muted ? 1 : 0.6,
          }}
        >
          {muted ? '🔇' : '🔊'}
        </button>
      )}
    </div>
  );
};

export default MaVolumeDialWidget;
