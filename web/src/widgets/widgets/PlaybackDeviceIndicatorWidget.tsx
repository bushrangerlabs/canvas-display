import React from 'react';
import type { WidgetProps } from '../types/index';
import type { WidgetMetadata } from '../types/metadata';
import { applyUniversalStyles } from '../utils/styleBuilder';
import { useResolvedUniversalStyle } from '../../hooks/useResolvedUniversalStyle';
import { mediaTypeOptions, usePlaybackRouting, destinationIcon, type PlaybackMediaType } from './media/playbackRouting';

export const PlaybackDeviceIndicatorWidgetMetadata: WidgetMetadata = {
  name: 'Current Playback Device', icon: 'ConnectedTv', category: 'media',
  description: 'Shows the current default or temporary destination for one media type',
  defaultSize: { w: 280, h: 90 }, minSize: { w: 150, h: 60 }, requiresEntity: false,
  fields: [
    { name: 'mediaType', type: 'select', label: 'Media type', default: 'dab', options: mediaTypeOptions, category: 'behavior' },
    { name: 'showReset', type: 'checkbox', label: 'Show reset button', default: true, category: 'behavior' },
    { name: 'fontSize', type: 'number', label: 'Text size', default: 14, min: 8, max: 36, category: 'style' },
    { name: 'backgroundColor', type: 'color', label: 'Background', default: '#12161f', category: 'style' },
    { name: 'textColor', type: 'color', label: 'Text', default: '#e6edf3', category: 'style' },
    { name: 'accentColor', type: 'color', label: 'Accent', default: '#4493f8', category: 'style' },
    { name: 'borderRadius', type: 'number', label: 'Corner radius', default: 12, min: 0, max: 40, category: 'style' },
  ],
};

const PlaybackDeviceIndicatorWidget: React.FC<WidgetProps> = ({ config, isEditMode }) => {
  const cfg = config.config ?? {};
  const mediaType = (cfg.mediaType || 'dab') as PlaybackMediaType;
  const routing = usePlaybackRouting(mediaType);
  const destination = routing.destinations.find(item => item.kind === routing.current?.kind && item.id === routing.current?.id);
  const universal = useResolvedUniversalStyle(cfg.style);
  return <div style={applyUniversalStyles(universal, {
    width: config.position?.width ?? cfg.width ?? 280, height: config.position?.height ?? cfg.height ?? 90,
    boxSizing: 'border-box', padding: 12, display: 'flex', alignItems: 'center', gap: 12,
    borderRadius: cfg.borderRadius ?? 12, background: cfg.backgroundColor ?? '#12161f', color: cfg.textColor ?? '#e6edf3',
  })}>
    <span style={{ fontSize: 28 }}>{destination ? destinationIcon(destination.kind) : '▣'}</span>
    <span style={{ minWidth: 0, flex: 1, fontSize: Number(cfg.fontSize ?? 14) }}><strong style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{destination?.name || routing.current?.name || 'No playback device'}</strong><small style={{ opacity: .6 }}>{mediaTypeOptions.find(item => item.value === mediaType)?.label} · {routing.temporary ? 'Temporary' : 'Default'}</small></span>
    {cfg.showReset !== false && routing.temporary && <button type="button" disabled={isEditMode} onClick={() => void routing.reset()} style={{ color: cfg.accentColor ?? '#4493f8', background: 'transparent', border: '1px solid currentColor', borderRadius: 6, padding: '5px 8px' }}>Reset</button>}
  </div>;
};
export default PlaybackDeviceIndicatorWidget;
