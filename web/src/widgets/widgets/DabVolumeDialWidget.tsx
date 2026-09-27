/**
 * DAB+ Volume Dial widget — rotary volume control.
 */

import React from 'react';
import type { WidgetProps } from '../types/index';
import MediaVolumeDial from './media/MediaVolumeDial';
import { volumeDialMetadata } from './media/mediaMetadata';

export const DabVolumeDialWidgetMetadata = volumeDialMetadata('dab');

const DabVolumeDialWidget: React.FC<WidgetProps> = (props) => <MediaVolumeDial {...props} kind="dab" />;

export default DabVolumeDialWidget;
