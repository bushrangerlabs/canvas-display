/**
 * Widget Metadata System
 * Defines structure for widget metadata and inspector fields
 */

export type FieldType = 
  | 'text'
  | 'number'
  | 'color'
  | 'select'
  | 'checkbox'
  | 'entity'
  | 'widget'
  | 'icon'
  | 'slider'
  | 'textarea'
  | 'font'
  | 'file'
  | 'code-editor';

export interface FieldOption {
  value: string | number;
  label: string;
}

export interface FieldMetadata {
  name: string;
  type: FieldType;
  label: string;
  default?: any;
  category?: 'layout' | 'style' | 'behavior';
  
  // Validation
  min?: number;
  max?: number;
  step?: number;
  
  // Options for select type
  options?: FieldOption[];
  
  // Binding support
  binding?: boolean;
  
  // Conditional visibility
  visibleWhen?: {
    field: string;
    value: any;
  };
  
  // Help text
  description?: string;

  // Entity domain filter (for type: 'entity')
  domains?: string[];
}

export interface WidgetMetadata {
  // Identity
  name: string;
  icon: string;
  category: string;
  description: string;
  /** Natural-language names accepted by AI tooling (for example "dial" → knob). */
  aliases?: string[];
  /** Search and prompt vocabulary that describes common use cases. */
  tags?: string[];
  /** Compact guidance for AI-generated configurations. */
  aiHints?: string[];
  
  // Sizing
  defaultSize: { w: number; h: number };
  minSize?: { w: number; h: number };
  maxSize?: { w: number; h: number };
  
  // Behavior
  requiresEntity?: boolean;
  
  // Inspector fields
  fields: FieldMetadata[];
}

/**
 * Base widget interface with metadata
 */
export interface WidgetWithMetadata {
  getMetadata(): WidgetMetadata;
}
