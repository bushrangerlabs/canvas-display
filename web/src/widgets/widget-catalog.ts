// Canvas UI's authoritative widget metadata registry, with Lovelace excluded.
export { WIDGET_REGISTRY as WIDGET_CATALOG } from './registry/widgetRegistry';
export type { WidgetMetadata, FieldMetadata } from './types/metadata';

export const CATEGORY_ORDER = ['basic', 'display', 'clock', 'control', 'media', 'layout'];
export const CATEGORY_LABELS: Record<string, string> = {
  basic: 'Basic',
  display: 'Display',
  clock: 'Clock',
  control: 'Control',
  media: 'Media',
  layout: 'Layout',
};
