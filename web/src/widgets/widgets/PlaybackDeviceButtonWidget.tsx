import React from 'react';
import type { WidgetProps } from '../types/index';
import type { WidgetMetadata } from '../types/metadata';
import { applyUniversalStyles } from '../utils/styleBuilder';
import { useResolvedUniversalStyle } from '../../hooks/useResolvedUniversalStyle';
import { mediaTypeOptions, usePlaybackRouting, destinationIcon, type PlaybackMediaType } from './media/playbackRouting';

export const PlaybackDeviceButtonWidgetMetadata: WidgetMetadata = {
  name: 'Playback Device Button', icon: 'Speaker', category: 'media',
  description: 'One button that temporarily selects a configured playback destination',
  defaultSize: { w: 240, h: 76 }, minSize: { w: 120, h: 48 }, requiresEntity: false,
  fields: [
    { name: 'mediaType', type: 'select', label: 'Media type', default: 'dab', options: mediaTypeOptions, category: 'behavior' },
    { name: 'destination', type: 'select', label: 'Playback destination', default: '', optionsSource: '/api/media/destinations/catalog', optionsSourceKey: 'destinations', optionValueKey: 'value', optionLabelKey: 'label', category: 'behavior' },
    { name: 'label', type: 'text', label: 'Label override', default: '', category: 'behavior' },
    { name: 'iconSize', type: 'number', label: 'Icon size', default: 30, min: 14, max: 80, category: 'style' },
    { name: 'fontSize', type: 'number', label: 'Text size', default: 14, min: 8, max: 36, category: 'style' },
    { name: 'backgroundColor', type: 'color', label: 'Background', default: '#12161f', category: 'style' },
    { name: 'textColor', type: 'color', label: 'Text', default: '#e6edf3', category: 'style' },
    { name: 'accentColor', type: 'color', label: 'Accent', default: '#4493f8', category: 'style' },
    { name: 'borderRadius', type: 'number', label: 'Corner radius', default: 12, min: 0, max: 40, category: 'style' },
  ],
};

const PlaybackDeviceButtonWidget: React.FC<WidgetProps> = ({ config, isEditMode }) => {
  const cfg = config.config ?? {};
  const routing = usePlaybackRouting((cfg.mediaType || 'dab') as PlaybackMediaType);
  const [kind, ...idParts] = String(cfg.destination ?? '').split(':');
  const id = idParts.join(':');
  const destination = routing.destinations.find(item => item.kind === kind && item.id === id);
  const selected = !!destination && routing.current?.kind === destination.kind && routing.current?.id === destination.id;
  const disabled = isEditMode || !destination?.compatible || !destination?.available;
  const accent = cfg.accentColor ?? '#4493f8';
  const universal = useResolvedUniversalStyle(cfg.style);
  return <button type="button" disabled={disabled} onClick={() => destination && void routing.select(destination)} title={destination?.reason || routing.error} style={applyUniversalStyles(universal, {
    width: config.position?.width ?? cfg.width ?? 240, height: config.position?.height ?? cfg.height ?? 76,
    boxSizing: 'border-box', borderRadius: cfg.borderRadius ?? 12, border: `1px solid ${accent}`,
    background: selected ? `${accent}33` : cfg.backgroundColor ?? '#12161f', color: cfg.textColor ?? '#e6edf3',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 10,
    cursor: disabled ? 'default' : 'pointer', opacity: disabled && !isEditMode ? .45 : 1, fontSize: Number(cfg.fontSize ?? 14), fontWeight: 700,
  })}>
    <span style={{ fontSize: Number(cfg.iconSize ?? 30) }}>{destination ? destinationIcon(destination.kind) : '▣'}</span>
    <span>{cfg.label || destination?.name || 'Choose a playback device'}</span>
    {selected && <span style={{ color: accent }}>✓</span>}
  </button>;
};
export default PlaybackDeviceButtonWidget;
