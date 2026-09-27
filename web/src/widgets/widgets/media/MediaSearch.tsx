/**
 * Shared search widget used by the DAB+ Search and Dispatcharr Search widgets.
 *
 * The user types a query and submits it; the query is pushed to the server-side
 * `search` filter on /api/dab/stations or /api/dispatcharr/channels so the
 * (potentially huge) lineup is never shipped to the display in full. Results are
 * playable, and optional next/previous buttons step through the matches.
 */

import React, { useCallback, useState } from 'react';
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

const MediaSearch: React.FC<WidgetProps & { kind: MediaKind }> = ({ config, isEditMode, kind }) => {
  const cfg = config.config ?? {};
  const width = config.position?.width ?? cfg.width ?? 320;
  const height = config.position?.height ?? cfg.height ?? 320;
  const backgroundColor = cfg.backgroundColor ?? '#12161f';
  const textColor = cfg.textColor ?? '#e6edf3';
  const accentColor = cfg.accentColor ?? defaultAccent(kind);
  const borderRadius = cfg.borderRadius ?? 12;
  const showHeader = cfg.showHeader !== false;
  const showPrevious = cfg.showPrevious === true;
  const showNext = cfg.showNext === true;
  const maxItems = Math.max(1, Number(cfg.maxItems ?? 50));
  const pollMs = Math.max(2, Number(cfg.pollInterval ?? defaultPollSeconds(kind))) * 1000;
  const isDab = kind === 'dab';
  const placeholder = cfg.placeholder || (isDab ? 'Search stations…' : 'Search channels…');

  const isVisible = useVisibility(cfg.visibilityCondition);
  const universalStyle = useResolvedUniversalStyle(config.config.style);

  const [query, setQuery] = useState('');
  // The committed query drives the server-side search; typing alone does not.
  const [committed, setCommitted] = useState('');
  const { items, error, play } = useMediaItems(kind, pollMs, committed.trim().length > 0, {
    search: committed,
    limit: maxItems,
  });
  // The audio state is only needed to resolve next/previous targets.
  const { audio } = useMediaAudio(pollMs, showNext || showPrevious);

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

  const submit = () => setCommitted(query.trim());

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

  const inputStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    backgroundColor: 'rgba(255,255,255,0.08)',
    border: 'none',
    borderRadius: 6,
    color: textColor,
    fontSize: 12,
    padding: '6px 10px',
    outline: 'none',
  };

  const resultButton: React.CSSProperties = {
    textAlign: 'left',
    background: 'rgba(255,255,255,0.06)',
    border: 'none',
    color: textColor,
    cursor: isEditMode ? 'default' : 'pointer',
    fontSize: 12,
    padding: '6px 8px',
    borderRadius: 6,
    display: 'flex',
    justifyContent: 'space-between',
    gap: 8,
    width: '100%',
  };

  return (
    <div style={containerStyle}>
      {showHeader && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16, color: accentColor }}>🔍</span>
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
            {cfg.title || (isDab ? 'DAB+ Search' : 'Channel Search')}
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
        </div>
      )}
      <form
        style={{ display: 'flex', gap: 6 }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          disabled={isEditMode}
          style={inputStyle}
        />
        <button
          type="submit"
          disabled={isEditMode || !query.trim()}
          style={{
            background: accentColor,
            border: 'none',
            color: '#fff',
            cursor: isEditMode ? 'default' : 'pointer',
            fontSize: 12,
            fontWeight: 600,
            padding: '6px 12px',
            borderRadius: 6,
            opacity: !query.trim() ? 0.5 : 1,
          }}
        >
          Go
        </button>
      </form>
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {error && <div style={{ color: '#f85149', fontSize: 10 }}>{error}</div>}
        {!committed.trim() && (
          <div style={{ color: textColor, fontSize: 11, opacity: 0.5 }}>
            Search {isDab ? 'stations' : 'channels'} by name
          </div>
        )}
        {committed.trim() && items.length === 0 && !error && (
          <div style={{ color: textColor, fontSize: 11, opacity: 0.5 }}>No results</div>
        )}
        {items.map((item) => (
          <button key={item.id} type="button" disabled={isEditMode} onClick={() => void play(item)} style={resultButton}>
            <span style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{item.name}</span>
            {item.subtitle && <span style={{ opacity: 0.5, fontSize: 10 }}>{item.subtitle}</span>}
          </button>
        ))}
      </div>
    </div>
  );
};

export default MediaSearch;
