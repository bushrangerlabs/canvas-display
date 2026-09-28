import React from 'react'; import type { WidgetProps } from '../types/index'; import View from './media/MaQueueWidget'; import { maQueueMetadata } from './media/maMetadata';
export const MaQueueWidgetMetadata=maQueueMetadata(); const Widget:React.FC<WidgetProps>=props=><View {...props}/>; export default Widget;
