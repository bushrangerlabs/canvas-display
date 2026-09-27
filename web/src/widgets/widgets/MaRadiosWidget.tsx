/**
 * Music Assistant Radio Stations widget — MA radio list (includes the DAB+
 * SDR provider). Tap a station to play it on the target player.
 */

import React from 'react';
import type { WidgetProps } from '../types/index';
import MaRadios from './media/MaRadiosWidget';
import { maRadiosMetadata } from './media/maMetadata';

export const MaRadiosWidgetMetadata = maRadiosMetadata();

const MaRadiosWidget: React.FC<WidgetProps> = (props) => <MaRadios {...props} />;

export default MaRadiosWidget;
