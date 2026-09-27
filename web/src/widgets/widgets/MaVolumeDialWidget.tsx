/**
 * Music Assistant Volume Dial widget — rotary volume for the configured
 * MA player.
 */

import React from 'react';
import type { WidgetProps } from '../types/index';
import MaVolumeDial from './media/MaVolumeDialWidget';
import { maVolumeDialMetadata } from './media/maMetadata';

export const MaVolumeDialWidgetMetadata = maVolumeDialMetadata();

const MaVolumeDialWidget: React.FC<WidgetProps> = (props) => <MaVolumeDial {...props} />;

export default MaVolumeDialWidget;
