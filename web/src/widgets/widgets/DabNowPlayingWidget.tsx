/**
 * DAB+ Now Playing widget — shows the current station / track and state.
 */

import React from 'react';
import type { WidgetProps } from '../types/index';
import MediaNowPlaying from './media/MediaNowPlaying';
import { nowPlayingMetadata } from './media/mediaMetadata';

export const DabNowPlayingWidgetMetadata = nowPlayingMetadata('dab');

const DabNowPlayingWidget: React.FC<WidgetProps> = (props) => <MediaNowPlaying {...props} kind="dab" />;

export default DabNowPlayingWidget;
