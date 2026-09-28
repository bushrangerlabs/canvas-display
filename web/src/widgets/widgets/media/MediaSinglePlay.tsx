import React from 'react';
import { useVisibility } from '../../../hooks/useVisibility';
import { useResolvedUniversalStyle } from '../../../hooks/useResolvedUniversalStyle';
import type { WidgetProps } from '../../types/index';
import { applyUniversalStyles } from '../../utils/styleBuilder';
import { defaultAccent, defaultPollSeconds, useMediaItems, type MediaKind } from './mediaSource';

const MediaSinglePlay: React.FC<WidgetProps & { kind: MediaKind }> = ({ config, isEditMode, kind }) => {
  const cfg = config.config ?? {};
  const width = config.position?.width ?? cfg.width ?? 220;
  const height = config.position?.height ?? cfg.height ?? 72;
  const selectedValue = String(cfg.item ?? '').trim();
  const pollMs = Math.max(2, Number(cfg.pollInterval ?? defaultPollSeconds(kind))) * 1000;
  const { items, error, play, playByName } = useMediaItems(kind, pollMs, true, {
    search: kind === 'dispatcharr' ? selectedValue : undefined,
    limit: kind === 'dab' ? 1000 : 10,
  });
  const item = items.find(candidate => candidate.id === selectedValue || candidate.name === selectedValue);
  const label = String(cfg.label || item?.name || selectedValue || (kind === 'dab' ? 'Choose a station' : 'Set a channel'));
  const showIcon = cfg.showIcon !== false;
  const iconSize = Math.max(16, Number(cfg.iconSize ?? 36));
  const accent = cfg.accentColor ?? defaultAccent(kind);
  const textColor = cfg.textColor ?? '#e6edf3';
  const visible = useVisibility(cfg.visibilityCondition);
  const universalStyle = useResolvedUniversalStyle(config.config.style);

  if (!visible) return null;
  const disabled = isEditMode || !selectedValue;
  return (
    <button
      type="button"
      disabled={disabled}
      title={error || label}
      onClick={() => void (item ? play(item) : playByName(selectedValue))}
      style={applyUniversalStyles(universalStyle, {
        width, height, boxSizing: 'border-box', borderRadius: cfg.borderRadius ?? 12,
        border: `1px solid ${accent}`, background: cfg.backgroundColor ?? '#12161f', color: textColor,
        padding: '8px 14px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
        cursor: disabled ? 'default' : 'pointer', fontSize: Number(cfg.fontSize ?? 14), fontWeight: 600,
        overflow: 'hidden', opacity: disabled && !isEditMode ? 0.6 : 1,
      })}
    >
      {showIcon && (item?.logo
        ? <img src={item.logo} alt="" loading="lazy" style={{ width: iconSize, height: iconSize, objectFit: 'contain', flex: '0 0 auto', borderRadius: 4 }} />
        : <span aria-hidden="true" style={{ fontSize: Math.max(16, iconSize * 0.65), flex: '0 0 auto' }}>{kind === 'dab' ? '📻' : '📺'}</span>)}
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </button>
  );
};

export default MediaSinglePlay;
