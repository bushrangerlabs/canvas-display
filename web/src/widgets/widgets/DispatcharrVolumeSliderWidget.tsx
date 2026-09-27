/**
 * Dispatcharr Volume Slider widget — horizontal or vertical volume control.
 */

import React from 'react';
import type { WidgetProps } from '../types/index';
import MediaVolumeSlider from './media/MediaVolumeSlider';
import { volumeSliderMetadata } from './media/mediaMetadata';

export const DispatcharrVolumeSliderWidgetMetadata = volumeSliderMetadata('dispatcharr');

const DispatcharrVolumeSliderWidget: React.FC<WidgetProps> = (props) => <MediaVolumeSlider {...props} kind="dispatcharr" />;

export default DispatcharrVolumeSliderWidget;
