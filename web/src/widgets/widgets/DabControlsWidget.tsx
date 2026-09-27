/**
 * DAB+ Controls widget — play/pause, stop and mute buttons.
 * Which buttons appear is configurable via checkboxes in the inspector.
 */

import React from 'react';
import type { WidgetProps } from '../types/index';
import MediaControls from './media/MediaControls';
import { controlsMetadata } from './media/mediaMetadata';

export const DabControlsWidgetMetadata = controlsMetadata('dab');

const DabControlsWidget: React.FC<WidgetProps> = (props) => <MediaControls {...props} kind="dab" />;

export default DabControlsWidget;
