/**
 * Music Assistant Players widget — whole-home player overview.
 * Compose it with the other MA widgets to build a custom layout.
 */

import React from 'react';
import type { WidgetProps } from '../types/index';
import MaPlayers from './media/MaPlayersWidget';
import { maPlayersMetadata } from './media/maMetadata';

export const MaPlayersWidgetMetadata = maPlayersMetadata();

const MaPlayersWidget: React.FC<WidgetProps> = (props) => <MaPlayers {...props} />;

export default MaPlayersWidget;
