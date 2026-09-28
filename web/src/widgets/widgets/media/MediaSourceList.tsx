/**
 * Shared station / channel picker used by the DAB+ Stations and
 * Dispatcharr Channels widgets.
 */

import React, { useCallback } from 'react';
import { useVisibility } from '../../../hooks/useVisibility';
import { useResolvedUniversalStyle } from '../../../hooks/useResolvedUniversalStyle';
import type { WidgetProps } from '../../types/index';
import { applyUniversalStyles } from '../../utils/styleBuilder';
import {
  defaultAccent,
  defaultPollSeconds,
  findCurrentIndex,
  stepTargetIndex,
  useMediaAudio,
  useMediaItems,
  type MediaKind,
} from './mediaSource';

function navButtonStyle(textColor: string, disabled: boolean): React.CSSProperties {
  return {
    width: 24,
    height: 24,
    borderRadius: 12,
    border: 'none',
    padding: 0,
    lineHeight: 1,
    fontSize: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(255,255,255,0.08)',
    color: textColor,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.35 : 1,
  };
}

const MediaSourceList: React.FC<WidgetProps & { kind: MediaKind }> = ({ config, isEditMode, kind }) => {
  const cfg = config.config ?? {};
  const width = config.position?.width ?? cfg.width ?? 300;
  const height = config.position?.height ?? cfg.height ?? 320;
  const backgroundColor = cfg.backgroundColor ?? '#12161f';
  const textColor = cfg.textColor ?? '#e6edf3';
  const accentColor = cfg.accentColor ?? defaultAccent(kind);
  const borderRadius = cfg.borderRadius ?? 12;
  const showHeader = cfg.showHeader !== false;
  const showPrevious = cfg.showPrevious === true;
  const showNext = cfg.showNext === true;
  const filter = String(cfg.search ?? '').trim().toLowerCase();
  const maxItems = Math.max(1, Number(cfg.maxItems ?? 200));
  const pollMs = Math.max(2, Number(cfg.pollInterval ?? defaultPollSeconds(kind))) * 1000;
  const isDab = kind === 'dab';
  const showIcons = cfg.showIcons !== false;
  const iconSize = Math.max(16, Number(cfg.iconSize ?? 32));
  const rowHeight = Math.max(28, Number(cfg.rowHeight ?? 48));
  const fontSize = Math.max(8, Number(cfg.fontSize ?? 12));

  const isVisible = useVisibility(cfg.visibilityCondition);
  const { items, error, play } = useMediaItems(kind, pollMs, true, { search: cfg.search, limit: maxItems });
  // The audio state is only needed to resolve next/previous targets.
  const { audio } = useMediaAudio(pollMs, showNext || showPrevious);
  const universalStyle = useResolvedUniversalStyle(config.config.style);

  const currentIndex = findCurrentIndex(items, audio.title);

  const step = useCallback(
    (direction: 1 | -1) => {
      const target = stepTargetIndex(items, currentIndex, direction);
      if (target === -1) return;
      void play(items[target]);
    },
    [items, currentIndex, play],
  );

  if (!isVisible) return null;

  const visible = (filter ? items.filter((item) => item.name.toLowerCase().includes(filter)) : items).slice(0, maxItems);

  const containerStyle = applyUniversalStyles(universalStyle, {
    width,
    height,
    backgroundColor,
    borderRadius,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    boxSizing: 'border-box',
    padding: 12,
    gap: 8,
  });

  return (
    <div style={containerStyle}>
      {showHeader && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 18, color: accentColor }}>{isDab ? '📻' : '📺'}</span>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              color: textColor,
              fontSize: 12,
              fontWeight: 600,
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
            }}
          >
            {cfg.title || (isDab ? 'DAB+ Stations' : 'Channels')}
          </div>
          {(showPrevious || showNext) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {showPrevious && (
                <button
                  type="button"
                  aria-label="Previous"
                  disabled={isEditMode || items.length === 0}
                  onClick={() => step(-1)}
                  style={navButtonStyle(textColor, isEditMode || items.length === 0)}
                >
                  ⏮
                </button>
              )}
              {showNext && (
                <button
                  type="button"
                  aria-label="Next"
                  disabled={isEditMode || items.length === 0}
                  onClick={() => step(1)}
                  style={navButtonStyle(textColor, isEditMode || items.length === 0)}
                >
                  ⏭
                </button>
              )}
            </div>
          )}
          <span style={{ color: textColor, fontSize: 10, opacity: 0.5 }}>{visible.length}</span>
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {visible.length === 0 && (
          <div style={{ color: textColor, fontSize: 11, opacity: 0.5 }}>
            No {isDab ? 'stations' : 'channels'} available
          </div>
        )}
        {visible.map((item) => (
          <button
            key={item.id}
            disabled={isEditMode}
            onClick={() => void play(item)}
            style={{
              textAlign: 'left',
              background: 'rgba(255,255,255,0.06)',
              border: 'none',
              color: textColor,
              cursor: isEditMode ? 'default' : 'pointer',
              fontSize,
              padding: '4px 8px',
              minHeight: rowHeight,
              flex: '0 0 auto',
              borderRadius: 6,
              display: 'flex',
              justifyContent: 'space-between',
              gap: 8,
              alignItems: 'center',
            }}
          >
            {showIcons && (item.logo
              ? <img src={item.logo} alt="" loading="lazy" style={{ width: iconSize, height: iconSize, objectFit: 'contain', flex: '0 0 auto', borderRadius: 4 }} />
              : <span aria-hidden="true" style={{ width: iconSize, height: iconSize, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto', fontSize: Math.max(14, iconSize * 0.65) }}>{isDab ? '📻' : '📺'}</span>)}
            <span style={{ flex: 1, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{item.name}</span>
            {item.subtitle && <span style={{ opacity: 0.5, fontSize: 10 }}>{item.subtitle}</span>}
          </button>
        ))}
      </div>
      {error && <div style={{ color: '#f85149', fontSize: 10 }}>{error}</div>}
    </div>
  );
};

export default MediaSourceList;
