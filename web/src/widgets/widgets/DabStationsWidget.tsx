/**
 * DAB+ Stations widget — station picker only (no now-playing / controls).
 * Compose it with the other DAB+ widgets to build a custom layout.
 */

import React from 'react';
import type { WidgetProps } from '../types/index';
import MediaSourceList from './media/MediaSourceList';
import { stationsMetadata } from './media/mediaMetadata';

export const DabStationsWidgetMetadata = stationsMetadata('dab');

const DabStationsWidget: React.FC<WidgetProps> = (props) => <MediaSourceList {...props} kind="dab" />;

export default DabStationsWidget;
