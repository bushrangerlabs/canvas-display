/**
 * Music Assistant Search widget — search the MA library and play a result on
 * the target player.
 */

import React from 'react';
import type { WidgetProps } from '../types/index';
import MaSearch from './media/MaSearchWidget';
import { maSearchMetadata } from './media/maMetadata';

export const MaSearchWidgetMetadata = maSearchMetadata();

const MaSearchWidget: React.FC<WidgetProps> = (props) => <MaSearch {...props} />;

export default MaSearchWidget;
