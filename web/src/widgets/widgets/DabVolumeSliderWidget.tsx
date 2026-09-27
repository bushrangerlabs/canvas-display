/**
 * DAB+ Volume Slider widget — horizontal or vertical volume control.
 */

import React from 'react';
import type { WidgetProps } from '../types/index';
import MediaVolumeSlider from './media/MediaVolumeSlider';
import { volumeSliderMetadata } from './media/mediaMetadata';

export const DabVolumeSliderWidgetMetadata = volumeSliderMetadata('dab');

const DabVolumeSliderWidget: React.FC<WidgetProps> = (props) => <MediaVolumeSlider {...props} kind="dab" />;

export default DabVolumeSliderWidget;
