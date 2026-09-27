/**
 * Dispatcharr Volume Dial widget — rotary volume control.
 */

import React from 'react';
import type { WidgetProps } from '../types/index';
import MediaVolumeDial from './media/MediaVolumeDial';
import { volumeDialMetadata } from './media/mediaMetadata';

export const DispatcharrVolumeDialWidgetMetadata = volumeDialMetadata('dispatcharr');

const DispatcharrVolumeDialWidget: React.FC<WidgetProps> = (props) => <MediaVolumeDial {...props} kind="dispatcharr" />;

export default DispatcharrVolumeDialWidget;
