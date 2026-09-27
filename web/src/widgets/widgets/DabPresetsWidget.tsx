/**
 * DAB+ Presets widget — grid of favourite stations ticked in the inspector.
 */

import React from 'react';
import type { WidgetProps } from '../types/index';
import MediaPresets from './media/MediaPresets';
import { presetsMetadata } from './media/mediaMetadata';

export const DabPresetsWidgetMetadata = presetsMetadata('dab');

const DabPresetsWidget: React.FC<WidgetProps> = (props) => <MediaPresets {...props} kind="dab" />;

export default DabPresetsWidget;
