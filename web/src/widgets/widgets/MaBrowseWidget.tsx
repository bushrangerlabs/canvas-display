import React from 'react'; import type { WidgetProps } from '../types/index'; import View from './media/MaBrowseWidget'; import { maBrowseMetadata } from './media/maMetadata';
export const MaBrowseWidgetMetadata=maBrowseMetadata(); const Widget:React.FC<WidgetProps>=props=><View {...props}/>; export default Widget;
