// Shared widget types for Canvas Core editor

export interface WidgetConfig {
  id: string;
  type: string;
  name?: string;
  position: {
    x: number;
    y: number;
    width: number;
    height: number;
    zIndex?: number;
  };
  config: Record<string, any>;
  bindings?: Record<string, string>;
  visibility?: VisibilityConfig;
}

export interface WidgetProps {
  config: WidgetConfig;
  isEditMode?: boolean;
  onUpdate?: (updates: Partial<WidgetConfig>) => void;
}

export type FieldType =
  | 'text' | 'number' | 'color' | 'select' | 'checkbox' | 'entity'
  | 'icon' | 'slider' | 'textarea' | 'font' | 'file' | 'code-editor';

export interface FieldOption {
  value: string | number;
  label: string;
}

export interface FieldMetadata {
  name: string;
  type: FieldType;
  label: string;
  defaultValue?: any;
  category?: 'layout' | 'style' | 'behavior';
  min?: number;
  max?: number;
  step?: number;
  options?: FieldOption[];
  description?: string;
  domains?: string[];
  visibleWhen?: { field: string; value: any };
}

export interface WidgetMetadata {
  name: string;
  icon: string;
  category: string;
  description: string;
  defaultSize: { w: number; h: number };
  minSize?: { w: number; h: number };
  maxSize?: { w: number; h: number };
  requiresEntity?: boolean;
  fields: FieldMetadata[];
}

export interface VisibilityConfig {
  type: 'always' | 'conditional' | 'entity_state';
  conditions?: Array<{ entity: string; state: string }>;
}

export interface EditorWidget {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  zIndex: number;
  locked: boolean;
  hidden: boolean;
  config: Record<string, any>;
}