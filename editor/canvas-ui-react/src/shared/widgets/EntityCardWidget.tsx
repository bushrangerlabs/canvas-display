import React from 'react';
import { UniversalIcon } from '../components/UniversalIcon';
import { useWidget } from '../hooks/useWidget';
import type { WidgetProps } from '../types';
import type { WidgetMetadata } from '../types/metadata';
import { applyUniversalStyles } from '../utils/styleBuilder';
import { useResolvedUniversalStyle } from '../../hooks/useResolvedUniversalStyle';

export const EntityCardWidgetMetadata: WidgetMetadata = {
  name: 'Entity Card',
  icon: 'SpaceDashboard',
  category: 'display',
  description: 'Responsive status tile with icon, label, value, unit, and availability state',
  aliases: ['status card', 'entity tile', 'sensor tile'],
  tags: ['home assistant', 'sensor', 'status', 'dashboard'],
  aiHints: [
    'Use one card per important entity and keep labels short.',
    'Set accentColor to communicate the entity domain or status.',
    'Use valueOverride for static dashboards; entity state wins when entity_id is set.',
  ],
  defaultSize: { w: 240, h: 112 },
  minSize: { w: 140, h: 72 },
  fields: [
    { name: 'entity_id', type: 'entity', label: 'Entity', default: '', category: 'behavior', binding: true },
    { name: 'label', type: 'text', label: 'Label', default: 'Status', category: 'behavior', binding: true },
    { name: 'valueOverride', type: 'text', label: 'Static Value', default: 'Ready', category: 'behavior', binding: true },
    { name: 'unit', type: 'text', label: 'Unit', default: '', category: 'behavior', binding: true },
    { name: 'icon', type: 'icon', label: 'Icon', default: 'mdi:information-outline', category: 'style' },
    { name: 'showIcon', type: 'checkbox', label: 'Show Icon', default: true, category: 'style' },
    { name: 'showEntityName', type: 'checkbox', label: 'Use Entity Friendly Name', default: false, category: 'behavior' },
    { name: 'showUnavailable', type: 'checkbox', label: 'Show Unavailable State', default: true, category: 'behavior' },
    { name: 'accentColor', type: 'color', label: 'Accent', default: '#60a5fa', category: 'style' },
    { name: 'textColor', type: 'color', label: 'Text', default: '#f8fafc', category: 'style' },
    { name: 'mutedColor', type: 'color', label: 'Muted Text', default: '#94a3b8', category: 'style' },
    { name: 'backgroundColor', type: 'color', label: 'Background', default: '#111827', category: 'style' },
    { name: 'compact', type: 'checkbox', label: 'Compact Layout', default: false, category: 'style' },
  ],
};

const EntityCardWidget: React.FC<WidgetProps> = ({ config }) => {
  const {
    label = 'Status',
    valueOverride = 'Ready',
    unit = '',
    icon = 'mdi:information-outline',
    showIcon = true,
    showEntityName = false,
    showUnavailable = true,
    accentColor = '#60a5fa',
    textColor = '#f8fafc',
    mutedColor = '#94a3b8',
    backgroundColor = '#111827',
    compact = false,
  } = config.config;
  const { getEntity } = useWidget(config);
  const entity = getEntity('entity_id');
  const unavailable = entity?.state === 'unavailable' || entity?.state === 'unknown';
  const value = unavailable && !showUnavailable ? valueOverride : (entity?.state ?? valueOverride);
  const friendlyName = entity?.attributes?.friendly_name;
  const displayLabel = showEntityName && friendlyName ? friendlyName : label;
  const displayUnit = unit || entity?.attributes?.unit_of_measurement || '';
  const universalStyle = useResolvedUniversalStyle(config.config.style || config.config as any);

  const style = applyUniversalStyles(universalStyle, {
    width: '100%',
    height: '100%',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: compact ? 10 : 16,
    padding: compact ? '10px 12px' : '16px 18px',
    color: textColor,
    background: `linear-gradient(135deg, ${backgroundColor}, color-mix(in srgb, ${backgroundColor} 82%, ${accentColor}))`,
    border: `1px solid color-mix(in srgb, ${accentColor} 35%, transparent)`,
    borderRadius: 16,
    overflow: 'hidden',
  });

  return (
    <div style={style} aria-label={config.config.ariaLabel || `${displayLabel}: ${value} ${displayUnit}`.trim()}>
      {showIcon && (
        <div style={{
          flex: '0 0 auto',
          width: compact ? 38 : 48,
          height: compact ? 38 : 48,
          borderRadius: 14,
          display: 'grid',
          placeItems: 'center',
          color: accentColor,
          background: `color-mix(in srgb, ${accentColor} 16%, transparent)`,
        }}>
          <UniversalIcon icon={icon} size={compact ? 23 : 29} />
        </div>
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ color: mutedColor, fontSize: compact ? 12 : 13, fontWeight: 600, letterSpacing: '.02em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {displayLabel}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
          <strong style={{ fontSize: compact ? 22 : 30, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {String(value)}
          </strong>
          {displayUnit && <span style={{ color: mutedColor, fontSize: compact ? 12 : 14 }}>{displayUnit}</span>}
        </div>
      </div>
      <span title={unavailable ? 'Unavailable' : 'Available'} style={{
        width: 8,
        height: 8,
        flex: '0 0 auto',
        borderRadius: '50%',
        background: unavailable ? '#f87171' : '#34d399',
        boxShadow: `0 0 10px ${unavailable ? '#f87171' : '#34d399'}`,
      }} />
    </div>
  );
};

export default EntityCardWidget;
