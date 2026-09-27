/**
 * Dispatcharr Channels widget — channel picker only (no now-playing / controls).
 * Compose it with the other Dispatcharr widgets to build a custom layout.
 */

import React from 'react';
import type { WidgetProps } from '../types/index';
import MediaSourceList from './media/MediaSourceList';
import { stationsMetadata } from './media/mediaMetadata';

export const DispatcharrChannelsWidgetMetadata = stationsMetadata('dispatcharr');

const DispatcharrChannelsWidget: React.FC<WidgetProps> = (props) => <MediaSourceList {...props} kind="dispatcharr" />;

export default DispatcharrChannelsWidget;
