import React from 'react';
import type { WidgetProps } from '../types/index';
import MediaSinglePlay from './media/MediaSinglePlay';
import { singlePlayMetadata } from './media/mediaMetadata';

export const DispatcharrPlayButtonWidgetMetadata = singlePlayMetadata('dispatcharr');
const DispatcharrPlayButtonWidget: React.FC<WidgetProps> = props => <MediaSinglePlay {...props} kind="dispatcharr" />;
export default DispatcharrPlayButtonWidget;
