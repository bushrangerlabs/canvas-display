import React from 'react';
import type { WidgetProps } from '../../types/index';
import MaSearch from './MaSearchWidget';
import MaPlaylists from './MaPlaylistsWidget';
import MaNowPlaying from './MaNowPlayingWidget';
import MaControls from './MaControlsWidget';
import MaVolume from './MaVolumeSliderWidget';
import { useMaControl, useMaPlayerId } from './maSource';

const withMode = (Component: React.ComponentType<WidgetProps>): React.FC<WidgetProps> => props => <Component {...props} config={{ ...props.config, config: { ...props.config.config, mediaType: 'youtube_music' } }} />;
export const YouTubeMusicSearch = withMode(MaSearch);
export const YouTubeMusicPresets = withMode(MaPlaylists);
export const YouTubeMusicNowPlaying = withMode(MaNowPlaying);
export const YouTubeMusicControls = withMode(MaControls);
export const YouTubeMusicVolume = withMode(MaVolume);

export const YouTubeMusicPlayButton: React.FC<WidgetProps> = ({ config, isEditMode }) => {
  const cfg = config.config ?? {};
  const playerId = useMaPlayerId(cfg.playerId, 10_000);
  const control = useMaControl(playerId, 'youtube_music');
  return <button disabled={isEditMode || !String(cfg.uri ?? '').trim()} onClick={() => void control.play(String(cfg.uri))} style={{ width: config.position?.width ?? cfg.width ?? 250, height: config.position?.height ?? cfg.height ?? 76, borderRadius: cfg.borderRadius ?? 12, border: `1px solid ${cfg.accentColor ?? '#ff1744'}`, background: cfg.backgroundColor ?? '#12161f', color: cfg.textColor ?? '#e6edf3', fontSize: Number(cfg.fontSize ?? 15), fontWeight: 700 }}>♫ {cfg.label || 'Play YouTube Music'}</button>;
};
