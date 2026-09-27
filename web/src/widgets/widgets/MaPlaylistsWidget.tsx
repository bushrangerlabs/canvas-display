/**
 * Music Assistant Playlists widget — tap a playlist to play it on the target
 * player.
 */

import React from 'react';
import type { WidgetProps } from '../types/index';
import MaPlaylists from './media/MaPlaylistsWidget';
import { maPlaylistsMetadata } from './media/maMetadata';

export const MaPlaylistsWidgetMetadata = maPlaylistsMetadata();

const MaPlaylistsWidget: React.FC<WidgetProps> = (props) => <MaPlaylists {...props} />;

export default MaPlaylistsWidget;
