/**
 * Dispatcharr Presets widget — grid of favourite channels ticked in the inspector.
 */

import React from 'react';
import type { WidgetProps } from '../types/index';
import MediaPresets from './media/MediaPresets';
import { presetsMetadata } from './media/mediaMetadata';

export const DispatcharrPresetsWidgetMetadata = presetsMetadata('dispatcharr');

const DispatcharrPresetsWidget: React.FC<WidgetProps> = (props) => <MediaPresets {...props} kind="dispatcharr" />;

export default DispatcharrPresetsWidget;
