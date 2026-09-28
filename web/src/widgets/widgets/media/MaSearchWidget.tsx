/**
 * Music Assistant Search — search the MA library (tracks, radio, playlists)
 * and play a result on the target player.
 */

import React, { useState } from 'react';
import { useVisibility } from '../../../hooks/useVisibility';
import { useResolvedUniversalStyle } from '../../../hooks/useResolvedUniversalStyle';
import type { WidgetProps } from '../../types/index';
import { applyUniversalStyles } from '../../utils/styleBuilder';
import { MA_ACCENT, maSearch, useMaControl, useMaPlayerId, type MaSearchResults } from './maSource';

const MaSearchWidget: React.FC<WidgetProps> = ({ config, isEditMode }) => {
  const cfg = config.config ?? {};
  const width = config.position?.width ?? cfg.width ?? 320;
  const height = config.position?.height ?? cfg.height ?? 320;
  const backgroundColor = cfg.backgroundColor ?? '#12161f';
  const textColor = cfg.textColor ?? '#e6edf3';
  const accentColor = cfg.accentColor ?? MA_ACCENT;
  const borderRadius = cfg.borderRadius ?? 12;
  const placeholder = cfg.placeholder || 'Search music…';
  const resultLimit = Math.min(50, Math.max(5, Number(cfg.resultLimit ?? 20)));
  const rowHeight = Math.max(28, Number(cfg.rowHeight ?? 52));
  const iconSize = Math.max(16, Number(cfg.iconSize ?? 36));
  const fontSize = Math.max(8, Number(cfg.fontSize ?? 12));
  const pollMs = 10_000; // only used to resolve the default player

  const isVisible = useVisibility(cfg.visibilityCondition);
  const playerId = useMaPlayerId(cfg.playerId, pollMs);
  const control = useMaControl(playerId, cfg.mediaType === 'youtube_music' ? 'youtube_music' : 'music_assistant');
  const universalStyle = useResolvedUniversalStyle(config.config.style);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MaSearchResults | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!isVisible) return null;

  const search = async () => {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setError('');
    try {
      setResults(await maSearch(q, resultLimit));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResults(null);
    } finally {
      setBusy(false);
    }
  };

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
    fontSize,
    padding: '5px 8px',
    minHeight: rowHeight,
    borderRadius: 6,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
  };

  return (
    <div style={containerStyle}>
      <form
        style={{ display: 'flex', gap: 6 }}
        onSubmit={(e) => {
          e.preventDefault();
          void search();
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
          disabled={isEditMode || busy || !query.trim()}
          style={{
            background: accentColor,
            border: 'none',
            color: '#fff',
            cursor: isEditMode ? 'default' : 'pointer',
            fontSize: 12,
            fontWeight: 600,
            padding: '6px 12px',
            borderRadius: 6,
            opacity: busy || !query.trim() ? 0.5 : 1,
          }}
        >
          {busy ? '…' : 'Go'}
        </button>
      </form>
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {error && <div style={{ color: '#f85149', fontSize: 10 }}>{error}</div>}
        {!results && !error && (
          <div style={{ color: textColor, fontSize: 11, opacity: 0.5 }}>
            Search tracks, radio stations and playlists
          </div>
        )}
        {results && (
          <>
            {results.artists?.map((artist) => (
              <button key={artist.uri} type="button" disabled={isEditMode} onClick={() => void control.play(artist.uri)} style={resultButton}>
                {artist.artwork ? <img src={artist.artwork} alt="" style={{width:iconSize,height:iconSize,borderRadius:4,objectFit:'cover'}}/> : <span>♬</span>}<span style={{flex:1}}>{artist.name}<small style={{display:'block',opacity:.5}}>Artist</small></span>
              </button>
            ))}
            {results.albums?.map((album) => (
              <button key={album.uri} type="button" disabled={isEditMode} onClick={() => void control.play(album.uri)} style={resultButton}>
                {album.artwork ? <img src={album.artwork} alt="" style={{width:iconSize,height:iconSize,borderRadius:4,objectFit:'cover'}}/> : <span>▣</span>}<span style={{flex:1}}>{album.name}<small style={{display:'block',opacity:.5}}>{album.artist || 'Album'}</small></span>
              </button>
            ))}
            {results.tracks.map((track) => (
              <button key={track.uri} type="button" disabled={isEditMode} onClick={() => void control.play(track.uri)} style={resultButton}>
                {track.artwork ? <img src={track.artwork} alt="" style={{width:iconSize,height:iconSize,borderRadius:4,objectFit:'cover'}}/> : <span style={{ fontSize: 12, opacity: 0.5, flexShrink: 0 }}>♪</span>}
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                  {track.name}
                  {track.artist && <span style={{ opacity: 0.5 }}> — {track.artist}</span>}
                </span>
              </button>
            ))}
            {results.radios.map((radio) => (
              <button key={radio.uri} type="button" disabled={isEditMode} onClick={() => void control.play(radio.uri)} style={resultButton}>
                <span style={{ fontSize: 12, opacity: 0.5, flexShrink: 0 }}>📻</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{radio.name}</span>
              </button>
            ))}
            {results.playlists.map((playlist) => (
              <button key={playlist.uri} type="button" disabled={isEditMode} onClick={() => void control.play(playlist.uri)} style={resultButton}>
                <span style={{ fontSize: 12, opacity: 0.5, flexShrink: 0 }}>🎵</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{playlist.name}</span>
              </button>
            ))}
            {(results.artists?.length ?? 0) + (results.albums?.length ?? 0) + results.tracks.length + results.radios.length + results.playlists.length === 0 && (
              <div style={{ color: textColor, fontSize: 11, opacity: 0.5 }}>No results</div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default MaSearchWidget;
