/**
 * Countdown Timer Widget
 * Visual countdown with configurable duration, circular progress, and optional auto-restart.
 * Voice-controllable via Canvas Core "set a timer" intent.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useVisibility } from '../../hooks/useVisibility';
import type { WidgetProps } from '../types/index';
import type { WidgetMetadata } from '../types/metadata';

export const CountdownTimerWidgetMetadata: WidgetMetadata = {
  name: 'Countdown Timer',
  icon: 'Timer',
  category: 'display',
  description: 'Visual countdown timer — set duration and optional label. Controllable via voice.',
  defaultSize: { w: 200, h: 200 },
  minSize: { w: 120, h: 120 },
  fields: [
    { name: 'duration', type: 'number', label: 'Duration (seconds)', default: 300, min: 1, max: 86400, category: 'behavior', description: 'Timer duration in seconds (300 = 5 min)' },
    { name: 'label', type: 'text', label: 'Label', default: 'Timer', category: 'behavior', description: 'Label displayed below the time' },
    { name: 'autoRestart', type: 'checkbox', label: 'Auto-restart when done', default: false, category: 'behavior' },
    { name: 'playSound', type: 'checkbox', label: 'Play sound on finish', default: false, category: 'behavior' },
    { name: 'backgroundColor', type: 'color', label: 'Background', default: 'transparent', category: 'style' },
    { name: 'ringColor', type: 'color', label: 'Ring colour', default: '#4a9eff', category: 'style' },
    { name: 'ringBgColor', type: 'color', label: 'Ring background', default: 'rgba(255,255,255,0.1)', category: 'style' },
    { name: 'textColor', type: 'color', label: 'Text colour', default: '#ffffff', category: 'style' },
    { name: 'doneColor', type: 'color', label: 'Done ring colour', default: '#ff5252', category: 'style' },
  ],
};

const CountdownTimerWidget: React.FC<WidgetProps> = ({ config }) => {
  const cfg = config.config ?? {};
  const width = config.position?.width ?? cfg.width ?? 200;
  const height = config.position?.height ?? cfg.height ?? 200;

  const duration: number = Math.max(1, Number(cfg.duration ?? 300));
  const label: string = cfg.label ?? 'Timer';
  const autoRestart: boolean = cfg.autoRestart ?? false;
  const backgroundColor: string = cfg.backgroundColor ?? 'transparent';
  const ringColor: string = cfg.ringColor ?? '#4a9eff';
  const ringBgColor: string = cfg.ringBgColor ?? 'rgba(255,255,255,0.1)';
  const textColor: string = cfg.textColor ?? '#ffffff';
  const doneColor: string = cfg.doneColor ?? '#ff5252';

  const isVisible = useVisibility(cfg.visibilityCondition);

  const [remaining, setRemaining] = useState(duration);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reset when duration config changes
  useEffect(() => {
    setRemaining(duration);
    setRunning(false);
    setDone(false);
  }, [duration]);

  const tick = useCallback(() => {
    setRemaining(prev => {
      if (prev <= 1) {
        setRunning(false);
        setDone(true);
        if (autoRestart) {
          setTimeout(() => {
            setRemaining(duration);
            setDone(false);
            setRunning(true);
          }, 2000);
        }
        return 0;
      }
      return prev - 1;
    });
  }, [autoRestart, duration]);

  useEffect(() => {
    if (running) {
      intervalRef.current = setInterval(tick, 1000);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [running, tick]);

  const reset = () => { setRemaining(duration); setRunning(false); setDone(false); };
  const toggle = () => {
    if (done) { reset(); return; }
    setRunning(r => !r);
  };

  const fmt = (s: number) => {
    if (s >= 3600) {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    }
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const size = Math.min(width, height);
  const cx = size / 2;
  const strokeWidth = Math.max(6, size * 0.07);
  const r = (size / 2) - strokeWidth / 2 - 4;
  const circumference = 2 * Math.PI * r;
  const progress = remaining / duration;
  const strokeDashoffset = circumference * (1 - progress);
  const currentRingColor = done ? doneColor : ringColor;
  const fontSize = Math.max(16, size * 0.22);

  if (!isVisible) return null;

  return (
    <div style={{
      width, height, backgroundColor,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      boxSizing: 'border-box',
    }}>
      <div style={{ position: 'relative', width: size, height: size, cursor: 'pointer' }}
        onClick={toggle} title={running ? 'Pause' : done ? 'Reset' : 'Start'}>
        <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
          {/* Background ring */}
          <circle cx={cx} cy={cx} r={r}
            fill="none" stroke={ringBgColor} strokeWidth={strokeWidth} />
          {/* Progress ring */}
          <circle cx={cx} cy={cx} r={r}
            fill="none"
            stroke={currentRingColor}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            style={{ transition: 'stroke-dashoffset 0.9s linear, stroke 0.3s' }}
          />
        </svg>

        {/* Center text */}
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          <span style={{
            color: done ? doneColor : textColor,
            fontSize,
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
            lineHeight: 1,
            transition: 'color 0.3s',
          }}>
            {done ? '✓' : fmt(remaining)}
          </span>
          {label && (
            <span style={{
              color: textColor, fontSize: fontSize * 0.28,
              opacity: 0.65, marginTop: 4,
              maxWidth: size * 0.7, overflow: 'hidden',
              whiteSpace: 'nowrap', textOverflow: 'ellipsis',
            }}>
              {done ? 'Done!' : label}
            </span>
          )}
        </div>
      </div>

      {/* Reset button — only when paused or done */}
      {!running && remaining !== duration && (
        <button
          onClick={(e) => { e.stopPropagation(); reset(); }}
          style={{
            position: 'absolute',
            bottom: 6, right: 8,
            background: 'rgba(255,255,255,0.12)',
            border: 'none', color: textColor,
            fontSize: 11, padding: '2px 8px',
            borderRadius: 4, cursor: 'pointer',
          }}
        >
          Reset
        </button>
      )}
    </div>
  );
};

export default CountdownTimerWidget;
