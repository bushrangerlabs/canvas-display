/**
 * Dispatcharr Widget — IPTV channel picker + now-playing.
 * Talks to the Display server's /api/dispatcharr/* routes (which proxy the
 * Dispatcharr HDHomeRun lineup).
 */

import React, { useEffect, useState } from 'react';
import { useVisibility } from '../../hooks/useVisibility';
import type { WidgetProps } from '../types/index';
import type { WidgetMetadata } from '../types/metadata';
import { applyUniversalStyles } from '../utils/styleBuilder';
import { useResolvedUniversalStyle } from '../../hooks/useResolvedUniversalStyle';

export const DispatcharrWidgetMetadata: WidgetMetadata = {
  name: 'Dispatcharr TV',
  icon: 'LiveTv',
  category: 'media',
  description: 'IPTV channels from Dispatcharr — pick a channel and show what is playing',
  defaultSize: { w: 320, h: 260 },
  minSize: { w: 200, h: 140 },
  requiresEntity: false,
  fields: [
    { name: 'pollInterval', type: 'number', label: 'Poll interval (s)', default: 10, min: 2, max: 120, category: 'behavior' },
    { name: 'search', type: 'text', label: 'Filter channels (substring)', default: '', category: 'behavior' },
    { name: 'showChannelList', type: 'checkbox', label: 'Show channel list', default: true, category: 'behavior' },
    { name: 'backgroundColor', type: 'color', label: 'Background', default: '#12161f', category: 'style' },
    { name: 'textColor', type: 'color', label: 'Text colour', default: '#e6edf3', category: 'style' },
    { name: 'accentColor', type: 'color', label: 'Accent colour', default: '#39d353', category: 'style' },
    { name: 'borderRadius', type: 'number', label: 'Corner radius', default: 12, min: 0, max: 40, category: 'style' },
  ],
};

interface DispatcharrChannel {
  number?: string;
  name?: string;
  url?: string;
}

const DispatcharrWidget: React.FC<WidgetProps> = ({ config }) => {
  const cfg = config.config ?? {};
  const width = config.position?.width ?? cfg.width ?? 320;
  const height = config.position?.height ?? cfg.height ?? 260;
  const backgroundColor = cfg.backgroundColor ?? '#12161f';
  const textColor = cfg.textColor ?? '#e6edf3';
  const accentColor = cfg.accentColor ?? '#39d353';
  const borderRadius = cfg.borderRadius ?? 12;
  const showChannelList = cfg.showChannelList !== false;
  const filter = String(cfg.search ?? '').trim().toLowerCase();
  const pollMs = Math.max(2, Number(cfg.pollInterval ?? 10)) * 1000;

  const isVisible = useVisibility(cfg.visibilityCondition);
  const [channels, setChannels] = useState<DispatcharrChannel[]>([]);
  const [current, setCurrent] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/dispatcharr/channels', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { channels?: DispatcharrChannel[] };
        if (!cancelled) setChannels(data.channels ?? []);
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

  const play = async (channel: DispatcharrChannel) => {
    setError('');
    try {
      const res = await fetch('/api/dispatcharr/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: channel.name, url: channel.url }),
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

  const visibleChannels = (filter
    ? channels.filter((channel) => (channel.name ?? '').toLowerCase().includes(filter))
    : channels
  ).slice(0, 200);

  const containerStyle = applyUniversalStyles(universalStyle, {
    width, height, backgroundColor, borderRadius,
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    boxSizing: 'border-box', padding: 12, gap: 8,
  });

  return (
    <div style={containerStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 20, color: accentColor }}>📺</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: textColor, fontSize: 13, fontWeight: 600, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
            {current || 'Dispatcharr TV'}
          </div>
          <div style={{ color: textColor, fontSize: 10, opacity: 0.6 }}>
            {channels.length > 0 ? `${channels.length} channels` : 'IPTV'}
          </div>
        </div>
      </div>
      {showChannelList && (
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {visibleChannels.length === 0 && (
            <div style={{ color: textColor, fontSize: 11, opacity: 0.5 }}>No channels available</div>
          )}
          {visibleChannels.map((channel) => (
            <button
              key={`${channel.number ?? ''}-${channel.name ?? ''}`}
              onClick={() => void play(channel)}
              style={{
                textAlign: 'left', background: 'rgba(255,255,255,0.06)', border: 'none',
                color: textColor, cursor: 'pointer', fontSize: 12, padding: '6px 8px',
                borderRadius: 6, display: 'flex', justifyContent: 'space-between', gap: 8,
              }}
            >
              <span style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{channel.name}</span>
              {channel.number && <span style={{ opacity: 0.5, fontSize: 10 }}>{channel.number}</span>}
            </button>
          ))}
        </div>
      )}
      {error && <div style={{ color: '#f85149', fontSize: 10 }}>{error}</div>}
    </div>
  );
};

export default DispatcharrWidget;
