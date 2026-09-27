/**
 * Music Assistant Volume Slider widget — sets the configured MA player volume.
 */

import React from 'react';
import type { WidgetProps } from '../types/index';
import MaVolumeSlider from './media/MaVolumeSliderWidget';
import { maVolumeSliderMetadata } from './media/maMetadata';

export const MaVolumeSliderWidgetMetadata = maVolumeSliderMetadata();

const MaVolumeSliderWidget: React.FC<WidgetProps> = (props) => <MaVolumeSlider {...props} />;

export default MaVolumeSliderWidget;
