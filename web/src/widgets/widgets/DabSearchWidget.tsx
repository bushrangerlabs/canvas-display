/**
 * DAB+ Search widget — search the SDR station lineup by name and tune a result.
 * Compose it with the other DAB+ widgets to build a custom layout.
 */

import React from 'react';
import type { WidgetProps } from '../types/index';
import MediaSearch from './media/MediaSearch';
import { searchMetadata } from './media/mediaMetadata';

export const DabSearchWidgetMetadata = searchMetadata('dab');

const DabSearchWidget: React.FC<WidgetProps> = (props) => <MediaSearch {...props} kind="dab" />;

export default DabSearchWidget;
