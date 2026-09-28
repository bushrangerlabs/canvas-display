/**
 * Metadata factories for the granular DAB+ / Dispatcharr widgets.
 *
 * Each factory returns a WidgetMetadata for one function (list, now-playing,
 * controls, volume, presets) so the two sources share identical inspector
 * fields and only differ in labels, icons and endpoints.
 */

import type { FieldMetadata, WidgetMetadata } from '../../types/metadata';
import { defaultAccent, defaultPollSeconds, sourceLabel, type MediaKind } from './mediaSource';

function styleFields(accent: string): FieldMetadata[] {
  return [
    { name: 'backgroundColor', type: 'color', label: 'Background', default: '#12161f', category: 'style' },
    { name: 'textColor', type: 'color', label: 'Text colour', default: '#e6edf3', category: 'style' },
    { name: 'accentColor', type: 'color', label: 'Accent colour', default: accent, category: 'style' },
    { name: 'borderRadius', type: 'number', label: 'Corner radius', default: 12, min: 0, max: 40, category: 'style' },
  ];
}

function pollField(kind: MediaKind): FieldMetadata {
  return {
    name: 'pollInterval',
    type: 'number',
    label: 'Poll interval (s)',
    default: defaultPollSeconds(kind),
    min: 2,
    max: 120,
    category: 'behavior',
  };
}

export function stationsMetadata(kind: MediaKind): WidgetMetadata {
  const isDab = kind === 'dab';
  return {
    name: isDab ? 'DAB+ Stations' : 'Dispatcharr Channels',
    icon: isDab ? 'Radio' : 'LiveTv',
    category: 'media',
    description: isDab
      ? 'DAB+ station picker — tap a station to tune and play it'
      : 'Dispatcharr channel picker — tap a channel to play it',
    defaultSize: { w: 300, h: 320 },
    minSize: { w: 160, h: 120 },
    requiresEntity: false,
    fields: [
      pollField(kind),
      { name: 'title', type: 'text', label: 'Header title', default: isDab ? 'DAB+ Stations' : 'Channels', category: 'behavior' },
      { name: 'showHeader', type: 'checkbox', label: 'Show header', default: true, category: 'behavior' },
      { name: 'showPrevious', type: 'checkbox', label: 'Show previous button', default: false, category: 'behavior' },
      { name: 'showNext', type: 'checkbox', label: 'Show next button', default: false, category: 'behavior' },
      { name: 'search', type: 'text', label: 'Filter (substring)', default: '', category: 'behavior' },
      { name: 'maxItems', type: 'number', label: 'Max items', default: 200, min: 1, max: 1000, category: 'behavior' },
      { name: 'showIcons', type: 'checkbox', label: 'Show station/channel icons', default: true, category: 'behavior' },
      { name: 'iconSize', type: 'number', label: 'Icon size (px)', default: 32, min: 16, max: 128, category: 'style' },
      { name: 'rowHeight', type: 'number', label: 'Button height (px)', default: 48, min: 28, max: 140, category: 'style' },
      { name: 'fontSize', type: 'number', label: 'Button text size (px)', default: 12, min: 8, max: 36, category: 'style' },
      ...styleFields(defaultAccent(kind)),
    ],
  };
}

export function nowPlayingMetadata(kind: MediaKind): WidgetMetadata {
  const label = sourceLabel(kind);
  const isDab = kind === 'dab';
  return {
    name: isDab ? 'DAB+ Now Playing' : 'Dispatcharr Now Playing',
    icon: isDab ? 'MusicNote' : 'Tv',
    category: 'media',
    description: `Shows what ${label} is currently playing — title, state and artwork`,
    defaultSize: { w: 340, h: 120 },
    minSize: { w: 160, h: 70 },
    requiresEntity: false,
    fields: [
      pollField(kind),
      { name: 'showArtwork', type: 'checkbox', label: 'Show artwork', default: true, category: 'behavior' },
      { name: 'showState', type: 'checkbox', label: 'Show playback state', default: true, category: 'behavior' },
      { name: 'showSource', type: 'checkbox', label: 'Show source label', default: true, category: 'behavior' },
      { name: 'emptyText', type: 'text', label: 'Empty text', default: 'Nothing playing', category: 'behavior' },
      ...styleFields(defaultAccent(kind)),
    ],
  };
}

export function controlsMetadata(kind: MediaKind): WidgetMetadata {
  const label = sourceLabel(kind);
  const isDab = kind === 'dab';
  return {
    name: isDab ? 'DAB+ Controls' : 'Dispatcharr Controls',
    icon: isDab ? 'PlayCircleOutline' : 'SettingsRemote',
    category: 'media',
    description: `Transport controls for ${label} — choose which buttons to show`,
    defaultSize: { w: 280, h: 96 },
    minSize: { w: 140, h: 60 },
    requiresEntity: false,
    fields: [
      pollField(kind),
      { name: 'showPlayPause', type: 'checkbox', label: 'Show play / pause', default: true, category: 'behavior' },
      { name: 'showStop', type: 'checkbox', label: 'Show stop', default: true, category: 'behavior' },
      { name: 'showPrevious', type: 'checkbox', label: 'Show previous', default: false, category: 'behavior' },
      { name: 'showNext', type: 'checkbox', label: 'Show next', default: false, category: 'behavior' },
      { name: 'showMute', type: 'checkbox', label: 'Show mute', default: true, category: 'behavior' },
      { name: 'showStatus', type: 'checkbox', label: 'Show status text', default: true, category: 'behavior' },
      { name: 'buttonSize', type: 'number', label: 'Button size (px)', default: 40, min: 24, max: 96, category: 'style' },
      ...styleFields(defaultAccent(kind)),
    ],
  };
}

export function volumeSliderMetadata(kind: MediaKind): WidgetMetadata {
  const label = sourceLabel(kind);
  const isDab = kind === 'dab';
  return {
    name: isDab ? 'DAB+ Volume Slider' : 'Dispatcharr Volume Slider',
    icon: 'VolumeUp',
    category: 'media',
    description: `Slider that sets the device volume while ${label} is playing`,
    defaultSize: { w: 280, h: 70 },
    minSize: { w: 120, h: 50 },
    requiresEntity: false,
    fields: [
      pollField(kind),
      { name: 'label', type: 'text', label: 'Label', default: 'Volume', category: 'behavior' },
      { name: 'showValue', type: 'checkbox', label: 'Show value', default: true, category: 'behavior' },
      { name: 'showMute', type: 'checkbox', label: 'Show mute button', default: true, category: 'behavior' },
      {
        name: 'orientation',
        type: 'select',
        label: 'Orientation',
        default: 'horizontal',
        category: 'behavior',
        options: [
          { value: 'horizontal', label: 'Horizontal' },
          { value: 'vertical', label: 'Vertical' },
        ],
      },
      { name: 'trackColor', type: 'color', label: 'Track colour', default: '#424242', category: 'style' },
      { name: 'fillColor', type: 'color', label: 'Fill colour', default: defaultAccent(kind), category: 'style' },
      { name: 'thumbColor', type: 'color', label: 'Thumb colour', default: defaultAccent(kind), category: 'style' },
      { name: 'backgroundColor', type: 'color', label: 'Background', default: '#12161f', category: 'style' },
      { name: 'textColor', type: 'color', label: 'Text colour', default: '#e6edf3', category: 'style' },
      { name: 'borderRadius', type: 'number', label: 'Corner radius', default: 12, min: 0, max: 40, category: 'style' },
    ],
  };
}

export function volumeDialMetadata(kind: MediaKind): WidgetMetadata {
  const label = sourceLabel(kind);
  const isDab = kind === 'dab';
  return {
    name: isDab ? 'DAB+ Volume Dial' : 'Dispatcharr Volume Dial',
    icon: 'DialpadOutlined',
    category: 'media',
    description: `Rotary dial that sets the device volume while ${label} is playing`,
    defaultSize: { w: 170, h: 170 },
    minSize: { w: 90, h: 90 },
    requiresEntity: false,
    fields: [
      pollField(kind),
      { name: 'label', type: 'text', label: 'Label', default: 'Volume', category: 'behavior' },
      { name: 'showValue', type: 'checkbox', label: 'Show value', default: true, category: 'behavior' },
      { name: 'showMute', type: 'checkbox', label: 'Show mute button', default: true, category: 'behavior' },
      { name: 'angleOffset', type: 'number', label: 'Angle offset (°)', default: 220, min: 0, max: 360, category: 'behavior' },
      { name: 'angleRange', type: 'number', label: 'Angle range (°)', default: 280, min: 0, max: 360, category: 'behavior' },
      { name: 'knobColor', type: 'color', label: 'Knob colour', default: '#1f2733', category: 'style' },
      { name: 'trackColor', type: 'color', label: 'Track colour', default: '#2a3444', category: 'style' },
      { name: 'fillColor', type: 'color', label: 'Fill colour', default: defaultAccent(kind), category: 'style' },
      { name: 'textColor', type: 'color', label: 'Text colour', default: '#e6edf3', category: 'style' },
      { name: 'backgroundColor', type: 'color', label: 'Background', default: '#12161f', category: 'style' },
      { name: 'borderRadius', type: 'number', label: 'Corner radius', default: 12, min: 0, max: 40, category: 'style' },
    ],
  };
}

export function presetsMetadata(kind: MediaKind): WidgetMetadata {
  const isDab = kind === 'dab';
  return {
    name: isDab ? 'DAB+ Presets' : 'Dispatcharr Presets',
    icon: 'Bookmarks',
    category: 'media',
    description: `Grid of preset ${isDab ? 'stations' : 'channels'} — tick the ones to show in the inspector`,
    defaultSize: { w: 320, h: 130 },
    minSize: { w: 140, h: 70 },
    requiresEntity: false,
    fields: [
      {
        name: 'presets',
        type: 'checklist',
        label: isDab ? 'Preset stations' : 'Preset channels',
        default: [],
        category: 'behavior',
        description: `Tick the ${isDab ? 'stations' : 'channels'} to show as preset buttons`,
        optionsSource: isDab ? '/api/dab/stations' : '/api/dispatcharr/channels',
        optionsSourceKey: isDab ? 'stations' : 'channels',
        optionValueKey: isDab ? 'id' : 'name',
        optionLabelKey: 'name',
      },
      pollField(kind),
      { name: 'columns', type: 'number', label: 'Columns', default: 3, min: 1, max: 8, category: 'behavior' },
      { name: 'showLabels', type: 'checkbox', label: 'Show labels', default: true, category: 'behavior' },
      { name: 'showIcons', type: 'checkbox', label: 'Show station/channel icons', default: true, category: 'behavior' },
      { name: 'iconSize', type: 'number', label: 'Icon size (px)', default: 28, min: 16, max: 128, category: 'style' },
      { name: 'buttonHeight', type: 'number', label: 'Button height (px)', default: 40, min: 24, max: 120, category: 'style' },
      ...styleFields(defaultAccent(kind)),
    ],
  };
}

export function searchMetadata(kind: MediaKind): WidgetMetadata {
  const label = sourceLabel(kind);
  const isDab = kind === 'dab';
  return {
    name: isDab ? 'DAB+ Search' : 'Dispatcharr Search',
    icon: 'Search',
    category: 'media',
    description: `Search ${label} ${isDab ? 'stations' : 'channels'} by name and play a result`,
    defaultSize: { w: 320, h: 320 },
    minSize: { w: 160, h: 120 },
    requiresEntity: false,
    fields: [
      pollField(kind),
      { name: 'title', type: 'text', label: 'Header title', default: isDab ? 'DAB+ Search' : 'Channel Search', category: 'behavior' },
      { name: 'showHeader', type: 'checkbox', label: 'Show header', default: true, category: 'behavior' },
      { name: 'showPrevious', type: 'checkbox', label: 'Show previous button', default: false, category: 'behavior' },
      { name: 'showNext', type: 'checkbox', label: 'Show next button', default: false, category: 'behavior' },
      { name: 'placeholder', type: 'text', label: 'Placeholder', default: isDab ? 'Search stations…' : 'Search channels…', category: 'behavior' },
      { name: 'maxItems', type: 'number', label: 'Max results', default: 50, min: 1, max: 500, category: 'behavior' },
      { name: 'rowHeight', type: 'number', label: 'Result height (px)', default: 44, min: 28, max: 140, category: 'style' },
      { name: 'iconSize', type: 'number', label: 'Artwork size (px)', default: 30, min: 16, max: 100, category: 'style' },
      { name: 'fontSize', type: 'number', label: 'Result text size (px)', default: 12, min: 8, max: 36, category: 'style' },
      ...styleFields(defaultAccent(kind)),
    ],
  };
}

export function singlePlayMetadata(kind: MediaKind): WidgetMetadata {
  const isDab = kind === 'dab';
  return {
    name: isDab ? 'DAB+ Play Button' : 'Dispatcharr Play Button',
    icon: isDab ? 'PlayCircle' : 'SmartDisplay',
    category: 'media',
    description: `A single button that plays one configured ${isDab ? 'DAB+ station' : 'Dispatcharr channel'}`,
    defaultSize: { w: 220, h: 72 },
    minSize: { w: 100, h: 48 },
    requiresEntity: false,
    fields: [
      ...(isDab ? [{
        name: 'item', type: 'select' as const, label: 'Station', default: '', category: 'behavior' as const,
        description: 'Choose a DAB+ station', optionsSource: '/api/dab/stations?limit=1000', optionsSourceKey: 'stations',
        optionValueKey: 'id', optionLabelKey: 'name',
      }] : [{ name: 'item', type: 'text' as const, label: 'Channel name', default: '', category: 'behavior' as const, description: 'Exact or partial Dispatcharr channel name' }]),
      { name: 'label', type: 'text', label: 'Button label override', default: '', category: 'behavior' },
      pollField(kind),
      { name: 'showIcon', type: 'checkbox', label: 'Show icon/logo', default: true, category: 'behavior' },
      { name: 'iconSize', type: 'number', label: 'Icon size (px)', default: 36, min: 16, max: 128, category: 'style' },
      { name: 'fontSize', type: 'number', label: 'Font size (px)', default: 14, min: 8, max: 48, category: 'style' },
      ...styleFields(defaultAccent(kind)),
    ],
  };
}
