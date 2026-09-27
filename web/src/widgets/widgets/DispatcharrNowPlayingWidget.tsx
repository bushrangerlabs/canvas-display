/**
 * Dispatcharr Now Playing widget — shows the current channel / programme and state.
 */

import React from 'react';
import type { WidgetProps } from '../types/index';
import MediaNowPlaying from './media/MediaNowPlaying';
import { nowPlayingMetadata } from './media/mediaMetadata';

export const DispatcharrNowPlayingWidgetMetadata = nowPlayingMetadata('dispatcharr');

const DispatcharrNowPlayingWidget: React.FC<WidgetProps> = (props) => <MediaNowPlaying {...props} kind="dispatcharr" />;

export default DispatcharrNowPlayingWidget;
