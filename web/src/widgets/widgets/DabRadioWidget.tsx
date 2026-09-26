/**
 * DAB+ Radio Widget — station picker + now-playing for the SDR digital radio.
 * Talks to the Display server's /api/dab/* routes (which proxy the SDR REST API).
 */

import React, { useEffect, useState } from 'react';
import { useVisibility } from '../../hooks/useVisibility';
import type { WidgetProps } from '../types/index';
import type { WidgetMetadata } from '../types/metadata';
import { applyUniversalStyles } from '../utils/styleBuilder';
import { useResolvedUniversalStyle } from '../../hooks/useResolvedUniversalStyle';

export const DabRadioWidgetMetadata: WidgetMetadata = {
  name: 'DAB+ Radio',
  icon: 'Radio',
  category: 'media',
  description: 'DAB+ digital radio — pick a station and show what is playing',
  defaultSize: { w: 320, h: 260 },
  minSize: { w: 200, h: 140 },
  requiresEntity: false,
  fields: [
    { name: 'pollInterval', type: 'number', label: 'Poll interval (s)', default: 5, min: 2, max: 60, category: 'behavior' },
    { name: 'showStationList', type: 'checkbox', label: 'Show station list', default: true, category: 'behavior' },
    { name: 'backgroundColor', type: 'color', label: 'Background', default: '#12161f', category: 'style' },
    { name: 'textColor', type: 'color', label: 'Text colour', default: '#e6edf3', category: 'style' },
    { name: 'accentColor', type: 'color', label: 'Accent colour', default: '#4493f8', category: 'style' },
    { name: 'borderRadius', type: 'number', label: 'Corner radius', default: 12, min: 0, max: 40, category: 'style' },
  ],
};

interface DabStation {
  id?: string;
  name?: string;
  city?: string;
}

const DabRadioWidget: React.FC<WidgetProps> = ({ config }) => {
  const cfg = config.config ?? {};
  const width = config.position?.width ?? cfg.width ?? 320;
  const height = config.position?.height ?? cfg.height ?? 260;
  const backgroundColor = cfg.backgroundColor ?? '#12161f';
  const textColor = cfg.textColor ?? '#e6edf3';
  const accentColor = cfg.accentColor ?? '#4493f8';
  const borderRadius = cfg.borderRadius ?? 12;
  const showStationList = cfg.showStationList !== false;
  const pollMs = Math.max(2, Number(cfg.pollInterval ?? 5)) * 1000;

  const isVisible = useVisibility(cfg.visibilityCondition);
  const [stations, setStations] = useState<DabStation[]>([]);
  const [current, setCurrent] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/dab/stations', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { stations?: DabStation[] };
        if (!cancelled) setStations(data.stations ?? []);
      } catch { /* ignore */ }
    };
    void load();
    const id = window.setInterval(load, pollMs);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [pollMs]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/media/state', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { audio?: { title?: string } };
        if (!cancelled) setCurrent(data.audio?.title ?? '');
      } catch { /* ignore */ }
    };
    void poll();
    const id = window.setInterval(poll, pollMs);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [pollMs]);

  const play = async (station: DabStation) => {
    setError('');
    try {
      const res = await fetch('/api/dab/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ station: station.id ?? station.name }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { error?: string };
        setError(detail.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const universalStyle = useResolvedUniversalStyle(config.config.style);
  if (!isVisible) return null;

  const containerStyle = applyUniversalStyles(universalStyle, {
    width, height, backgroundColor, borderRadius,
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    boxSizing: 'border-box', padding: 12, gap: 8,
  });

  return (
    <div style={containerStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 20, color: accentColor }}>📻</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: textColor, fontSize: 13, fontWeight: 600, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
            {current || 'DAB+ Radio'}
          </div>
          <div style={{ color: textColor, fontSize: 10, opacity: 0.6 }}>Digital radio</div>
        </div>
      </div>
      {showStationList && (
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {stations.length === 0 && (
            <div style={{ color: textColor, fontSize: 11, opacity: 0.5 }}>No stations available</div>
          )}
          {stations.map((station) => (
            <button
              key={station.id ?? station.name}
              onClick={() => void play(station)}
              style={{
                textAlign: 'left', background: 'rgba(255,255,255,0.06)', border: 'none',
                color: textColor, cursor: 'pointer', fontSize: 12, padding: '6px 8px',
                borderRadius: 6, display: 'flex', justifyContent: 'space-between', gap: 8,
              }}
            >
              <span style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{station.name}</span>
              {station.city && <span style={{ opacity: 0.5, fontSize: 10 }}>{station.city}</span>}
            </button>
          ))}
        </div>
      )}
      {error && <div style={{ color: '#f85149', fontSize: 10 }}>{error}</div>}
    </div>
  );
};

export default DabRadioWidget;
