import React from 'react';
import type { WidgetProps } from '../types/index';
import type { WidgetMetadata } from '../types/metadata';
import { applyUniversalStyles } from '../utils/styleBuilder';
import { useResolvedUniversalStyle } from '../../hooks/useResolvedUniversalStyle';
import { mediaTypeOptions, usePlaybackRouting, destinationIcon, destinationKindLabel, type PlaybackMediaType } from './media/playbackRouting';

export const PlaybackDeviceListWidgetMetadata: WidgetMetadata = {
  name: 'Playback Device List', icon: 'SpeakerGroup', category: 'media',
  description: 'Select the temporary playback destination for one media type',
  defaultSize: { w: 320, h: 320 }, minSize: { w: 180, h: 120 }, requiresEntity: false,
  fields: [
    { name: 'mediaType', type: 'select', label: 'Media type', default: 'dab', options: mediaTypeOptions, category: 'behavior' },
    { name: 'title', type: 'text', label: 'Title', default: 'Playback device', category: 'behavior' },
    { name: 'showUnavailable', type: 'checkbox', label: 'Show unavailable devices', default: true, category: 'behavior' },
    { name: 'rowHeight', type: 'number', label: 'Row height', default: 54, min: 32, max: 140, category: 'style' },
    { name: 'iconSize', type: 'number', label: 'Icon size', default: 26, min: 14, max: 80, category: 'style' },
    { name: 'fontSize', type: 'number', label: 'Text size', default: 13, min: 8, max: 36, category: 'style' },
    { name: 'backgroundColor', type: 'color', label: 'Background', default: '#12161f', category: 'style' },
    { name: 'textColor', type: 'color', label: 'Text', default: '#e6edf3', category: 'style' },
    { name: 'accentColor', type: 'color', label: 'Accent', default: '#4493f8', category: 'style' },
    { name: 'borderRadius', type: 'number', label: 'Corner radius', default: 12, min: 0, max: 40, category: 'style' },
  ],
};

const PlaybackDeviceListWidget: React.FC<WidgetProps> = ({ config, isEditMode }) => {
  const cfg = config.config ?? {};
  const mediaType = (cfg.mediaType || 'dab') as PlaybackMediaType;
  const routing = usePlaybackRouting(mediaType);
  const width = config.position?.width ?? cfg.width ?? 320;
  const height = config.position?.height ?? cfg.height ?? 320;
  const accent = cfg.accentColor ?? '#4493f8';
  const text = cfg.textColor ?? '#e6edf3';
  const universal = useResolvedUniversalStyle(cfg.style);
  const rows = routing.destinations.filter(item => cfg.showUnavailable !== false || item.available);
  return <div style={applyUniversalStyles(universal, { width, height, boxSizing: 'border-box', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 8, padding: 12, background: cfg.backgroundColor ?? '#12161f', color: text, borderRadius: cfg.borderRadius ?? 12 })}>
    <div style={{ fontWeight: 700, fontSize: Number(cfg.fontSize ?? 13) }}>{cfg.title || 'Playback device'} <span style={{ opacity: .5, fontWeight: 400 }}>· {mediaTypeOptions.find(x => x.value === mediaType)?.label}</span></div>
    <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 5 }}>
      {rows.map(item => {
        const selected = routing.current?.kind === item.kind && routing.current?.id === item.id;
        const disabled = isEditMode || !item.available || !item.compatible;
        return <button type="button" key={`${item.kind}:${item.id}`} disabled={disabled} title={item.reason} onClick={() => void routing.select(item)} style={{ minHeight: Number(cfg.rowHeight ?? 54), flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', color: text, fontSize: Number(cfg.fontSize ?? 13), textAlign: 'left', borderRadius: 8, border: selected ? `1px solid ${accent}` : '1px solid transparent', background: selected ? `${accent}22` : 'rgba(255,255,255,.06)', opacity: disabled && !isEditMode ? .4 : 1, cursor: disabled ? 'default' : 'pointer' }}>
          <span style={{ fontSize: Number(cfg.iconSize ?? 26) }}>{destinationIcon(item.kind)}</span>
          <span style={{ flex: 1 }}>{item.name}<small style={{ display: 'block', opacity: .55 }}>{destinationKindLabel(item.kind)}</small></span>
          {selected && <span style={{ color: accent }}>{routing.temporary ? 'Temporary' : 'Default'}</span>}
        </button>;
      })}
    </div>
    {routing.error && <div style={{ color: '#f85149', fontSize: 10 }}>{routing.error}</div>}
  </div>;
};
export default PlaybackDeviceListWidget;
