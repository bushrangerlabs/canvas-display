/**
 * Music Assistant Controls widget — transport buttons for the configured
 * MA player.
 */

import React from 'react';
import type { WidgetProps } from '../types/index';
import MaControls from './media/MaControlsWidget';
import { maControlsMetadata } from './media/maMetadata';

export const MaControlsWidgetMetadata = maControlsMetadata();

const MaControlsWidget: React.FC<WidgetProps> = (props) => <MaControls {...props} />;

export default MaControlsWidget;
