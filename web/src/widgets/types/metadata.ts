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
  | 'code-editor'
  | 'entity-list'
  | 'checklist';

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

  // Dynamic options for 'checklist' (and 'select') — fetched from an endpoint.
  // The response is expected to be an array at `optionsSourceKey`, or the whole
  // body if `optionsSourceKey` is omitted. Each item is mapped via
  // `optionValueKey` (default 'value') and `optionLabelKey` (default 'label').
  optionsSource?: string;
  optionsSourceKey?: string;
  optionValueKey?: string;
  optionLabelKey?: string;

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