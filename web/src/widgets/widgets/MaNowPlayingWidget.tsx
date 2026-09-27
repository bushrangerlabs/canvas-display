/**
 * Music Assistant Now Playing widget — artwork, title, artist and progress
 * for the configured MA player.
 */

import React from 'react';
import type { WidgetProps } from '../types/index';
import MaNowPlaying from './media/MaNowPlayingWidget';
import { maNowPlayingMetadata } from './media/maMetadata';

export const MaNowPlayingWidgetMetadata = maNowPlayingMetadata();

const MaNowPlayingWidget: React.FC<WidgetProps> = (props) => <MaNowPlaying {...props} />;

export default MaNowPlayingWidget;
