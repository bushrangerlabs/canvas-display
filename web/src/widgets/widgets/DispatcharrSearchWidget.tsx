/**
 * Dispatcharr Search widget — search the channel lineup by name and play a
 * result. The query is filtered server-side, so the huge channel list is never
 * shipped to the display in full.
 */

import React from 'react';
import type { WidgetProps } from '../types/index';
import MediaSearch from './media/MediaSearch';
import { searchMetadata } from './media/mediaMetadata';

export const DispatcharrSearchWidgetMetadata = searchMetadata('dispatcharr');

const DispatcharrSearchWidget: React.FC<WidgetProps> = (props) => <MediaSearch {...props} kind="dispatcharr" />;

export default DispatcharrSearchWidget;
