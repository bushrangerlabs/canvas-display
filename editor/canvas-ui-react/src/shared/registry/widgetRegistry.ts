/**
 * Central Widget Registry
 * Single source of truth for all widget metadata
 */

import type { WidgetMetadata } from '../types/metadata';
import { BorderWidgetMetadata } from '../widgets/BorderWidget';
import { ButtonWidgetMetadata } from '../widgets/ButtonWidget';
import { CalendarWidgetMetadata } from '../widgets/CalendarWidget';
import { cameraWidgetMetadata } from '../widgets/CameraWidget';
import { ColorPickerWidgetMetadata } from '../widgets/ColorPickerWidget';
import { DigitalClockWidgetMetadata } from '../widgets/DigitalClockWidget';
import { analogClockMetadata } from '../widgets/AnalogClockWidget';
import { FlipClockWidgetMetadata } from '../widgets/FlipClockWidget';
import { GaugeWidgetMetadata } from '../widgets/GaugeWidget';
import { GraphWidgetMetadata } from '../widgets/GraphWidget';
import { htmlWidgetMetadata } from '../widgets/HtmlWidget';
import { iconWidgetMetadata } from '../widgets/IconWidget';
import { IFrameWidgetMetadata } from '../widgets/IFrameWidget';
import { ImageWidgetMetadata } from '../widgets/ImageWidget';
import { InputTextWidgetMetadata } from '../widgets/InputTextWidget';
import { KeyboardWidgetMetadata } from '../widgets/KeyboardWidget';
import { KnobWidgetMetadata } from '../widgets/KnobWidget';
import { lovelaceCardWidgetMetadata } from '../widgets/LovelaceCardWidget';
import { ProgressBarWidgetMetadata } from '../widgets/ProgressBarWidget';
import { ProgressCircleWidgetMetadata } from '../widgets/ProgressCircleWidget';
import { RadioButtonWidgetMetadata } from '../widgets/RadioButtonWidget';
import { resolutionWidgetMetadata } from '../widgets/ResolutionWidget';
import { screensaverWidgetMetadata } from '../widgets/ScreensaverWidget';
import { ScrollingTextWidgetMetadata } from '../widgets/ScrollingTextWidget';
import { scrollableContainerMetadata } from '../widgets/ScrollableContainerWidget';
import { ShapeWidgetMetadata } from '../widgets/ShapeWidget';
import { SliderWidgetMetadata } from '../widgets/SliderWidget';
import { SwitchWidgetMetadata } from '../widgets/SwitchWidget';
import { TextWidgetMetadata } from '../widgets/TextWidget';
import { ValueWidgetMetadata } from '../widgets/ValueWidget';
import { weatherWidgetMetadata } from '../widgets/WeatherWidget';
import { EntityCardWidgetMetadata } from '../widgets/EntityCardWidget';

const UNIVERSAL_FIELDS: WidgetMetadata['fields'] = [
  { name: 'ariaLabel', type: 'text', label: 'Accessible Label', default: '', category: 'behavior', description: 'Screen-reader label and AI-readable purpose' },
  { name: 'overflow', type: 'select', label: 'Overflow', default: 'hidden', category: 'style', options: [
    { value: 'hidden', label: 'Hidden' },
    { value: 'visible', label: 'Visible' },
    { value: 'auto', label: 'Auto Scroll' },
  ]},
  { name: 'opacity', type: 'slider', label: 'Opacity', default: 1, min: 0, max: 1, step: 0.05, category: 'style' },
  { name: 'rotation', type: 'number', label: 'Rotation', default: 0, min: -360, max: 360, category: 'style' },
  { name: 'transitionDuration', type: 'number', label: 'Transition (ms)', default: 180, min: 0, max: 2000, category: 'style' },
];

const AI_ALIASES: Record<string, string[]> = {
  analogclock: ['analogue clock', 'clock face'],
  border: ['panel', 'frame', 'card background'],
  button: ['action', 'control', 'tap target'],
  digitalclock: ['time', 'digital time'],
  flipclock: ['split flap clock'],
  gauge: ['meter', 'dial'],
  graph: ['chart', 'history chart', 'trend'],
  iframe: ['web page', 'embedded page'],
  inputtext: ['text input', 'form field'],
  knob: ['dial', 'rotary control'],
  lovelacecard: ['home assistant card', 'ha card'],
  progressbar: ['progress bar', 'level bar'],
  progresscircle: ['progress ring', 'radial progress'],
  radiobutton: ['radio group', 'choice'],
  scrollablecontainer: ['container', 'scroll panel'],
  scrollingtext: ['ticker', 'marquee'],
  switch: ['toggle'],
  value: ['number', 'sensor value', 'readout'],
  entitycard: ['status card', 'entity tile', 'sensor card'],
};

function enrichMetadata(type: string, metadata: WidgetMetadata): WidgetMetadata {
  const existing = new Set(metadata.fields.map(field => field.name));
  return {
    ...metadata,
    aliases: metadata.aliases ?? AI_ALIASES[type] ?? [],
    tags: metadata.tags ?? [metadata.category, type],
    aiHints: metadata.aiHints ?? [
      `Prefer ${metadata.defaultSize.w}×${metadata.defaultSize.h}px unless the layout requires otherwise.`,
      metadata.requiresEntity ? 'Set entity_id to a valid Home Assistant entity.' : 'Can be used with static values.',
    ],
    fields: [...metadata.fields, ...UNIVERSAL_FIELDS.filter(field => !existing.has(field.name))],
  };
}

export interface WidgetRegistryEntry {
  type: string;
  metadata: WidgetMetadata;
}

// Central widget metadata registry - add new widgets here
const RAW_WIDGET_REGISTRY: Record<string, WidgetMetadata> = {
  button: ButtonWidgetMetadata,
  text: TextWidgetMetadata,
  gauge: GaugeWidgetMetadata,
  camera: cameraWidgetMetadata,
  slider: SliderWidgetMetadata,
  switch: SwitchWidgetMetadata,
  image: ImageWidgetMetadata,
  icon: iconWidgetMetadata,
  progressbar: ProgressBarWidgetMetadata,
  progresscircle: ProgressCircleWidgetMetadata,
  inputtext: InputTextWidgetMetadata,
  keyboard: KeyboardWidgetMetadata,
  analogclock: analogClockMetadata,
  flipclock: FlipClockWidgetMetadata,
  digitalclock: DigitalClockWidgetMetadata,
  knob: KnobWidgetMetadata,
  iframe: IFrameWidgetMetadata,
  border: BorderWidgetMetadata,
  lovelacecard: lovelaceCardWidgetMetadata,
  value: ValueWidgetMetadata,
  radiobutton: RadioButtonWidgetMetadata,
  colorpicker: ColorPickerWidgetMetadata,
  weather: weatherWidgetMetadata,
  resolution: resolutionWidgetMetadata,
  html: htmlWidgetMetadata,
  graph: GraphWidgetMetadata,
  calendar: CalendarWidgetMetadata,
  scrollingtext: ScrollingTextWidgetMetadata,
  shape: ShapeWidgetMetadata,
  screensaver: screensaverWidgetMetadata,
  scrollablecontainer: scrollableContainerMetadata,
  entitycard: EntityCardWidgetMetadata,
};

export const WIDGET_REGISTRY: Record<string, WidgetMetadata> = Object.fromEntries(
  Object.entries(RAW_WIDGET_REGISTRY).map(([type, metadata]) => [
    type,
    enrichMetadata(type, metadata),
  ]),
);

export function resolveWidgetType(input: string): string | undefined {
  const normalized = input.trim().toLowerCase().replace(/[\s_-]+/g, '');
  return Object.entries(WIDGET_REGISTRY).find(([type, metadata]) =>
    type === normalized ||
    metadata.name.toLowerCase().replace(/[\s_-]+/g, '') === normalized ||
    metadata.aliases?.some(alias => alias.toLowerCase().replace(/[\s_-]+/g, '') === normalized)
  )?.[0];
}

/**
 * Get all widget types
 */
export function getWidgetTypes(): string[] {
  return Object.keys(WIDGET_REGISTRY);
}

/**
 * Get metadata for a specific widget type
 */
export function getWidgetMetadata(type: string): WidgetMetadata | undefined {
  return WIDGET_REGISTRY[type];
}

/**
 * Get all widget entries as array (type + metadata pairs)
 */
export function getAllWidgets(): WidgetRegistryEntry[] {
  return Object.entries(WIDGET_REGISTRY).map(([type, metadata]) => ({
    type,
    metadata,
  }));
}
