/**
 * Metadata for the Music Assistant widget family.
 *
 * Each widget targets a Music Assistant player (chosen in the inspector via a
 * dynamic select fed by /api/ma/players) and talks to Core's /api/ma/*
 * endpoints. Keeping one metadata factory per function (players, now-playing,
 * controls, volume, radios, playlists, search) lets users compose custom
 * layouts from independent pieces.
 */

import type { FieldMetadata, WidgetMetadata } from '../../types/metadata';
import { MA_ACCENT } from './maSource';

function styleFields(accent: string): FieldMetadata[] {
  return [
    { name: 'backgroundColor', type: 'color', label: 'Background', default: '#12161f', category: 'style' },
    { name: 'textColor', type: 'color', label: 'Text colour', default: '#e6edf3', category: 'style' },
    { name: 'accentColor', type: 'color', label: 'Accent colour', default: accent, category: 'style' },
    { name: 'borderRadius', type: 'number', label: 'Corner radius', default: 12, min: 0, max: 40, category: 'style' },
  ];
}

function pollField(defaultSeconds = 5): FieldMetadata {
  return {
    name: 'pollInterval',
    type: 'number',
    label: 'Poll interval (s)',
    default: defaultSeconds,
    min: 2,
    max: 120,
    category: 'behavior',
  };
}

/** Dynamic player picker — options load from /api/ma/players. */
function playerField(label = 'Music Assistant player'): FieldMetadata {
  return {
    name: 'playerId',
    type: 'select',
    label,
    default: '',
    category: 'behavior',
    description: 'First available player is used when left blank',
    optionsSource: '/api/ma/players',
    optionsSourceKey: 'players',
    optionValueKey: 'id',
    optionLabelKey: 'name',
  };
}

export function maPlayersMetadata(): WidgetMetadata {
  return {
    name: 'MA Players',
    icon: 'Speaker',
    category: 'media',
    description: 'Music Assistant player overview — tap a player to play / pause it',
    defaultSize: { w: 300, h: 300 },
    minSize: { w: 160, h: 100 },
    requiresEntity: false,
    fields: [
      pollField(10),
      { name: 'title', type: 'text', label: 'Header title', default: 'Players', category: 'behavior' },
      { name: 'showHeader', type: 'checkbox', label: 'Show header', default: true, category: 'behavior' },
      { name: 'maxItems', type: 'number', label: 'Max items', default: 50, min: 1, max: 200, category: 'behavior' },
      ...styleFields(MA_ACCENT),
    ],
  };
}

export function maNowPlayingMetadata(): WidgetMetadata {
  return {
    name: 'MA Now Playing',
    icon: 'MusicNote',
    category: 'media',
    description: 'Shows what a Music Assistant player is playing — artwork, title, artist and progress',
    defaultSize: { w: 360, h: 120 },
    minSize: { w: 160, h: 70 },
    requiresEntity: false,
    fields: [
      playerField(),
      pollField(),
      { name: 'showArtwork', type: 'checkbox', label: 'Show artwork', default: true, category: 'behavior' },
      { name: 'showState', type: 'checkbox', label: 'Show playback state', default: true, category: 'behavior' },
      { name: 'showProgress', type: 'checkbox', label: 'Show progress bar', default: true, category: 'behavior' },
      { name: 'emptyText', type: 'text', label: 'Empty text', default: 'Nothing playing', category: 'behavior' },
      ...styleFields(MA_ACCENT),
    ],
  };
}

export function maControlsMetadata(): WidgetMetadata {
  return {
    name: 'MA Controls',
    icon: 'PlayCircleOutline',
    category: 'media',
    description: 'Transport controls for a Music Assistant player — choose which buttons to show',
    defaultSize: { w: 280, h: 96 },
    minSize: { w: 140, h: 60 },
    requiresEntity: false,
    fields: [
      playerField(),
      pollField(),
      { name: 'showPlayPause', type: 'checkbox', label: 'Show play / pause', default: true, category: 'behavior' },
      { name: 'showStop', type: 'checkbox', label: 'Show stop', default: true, category: 'behavior' },
      { name: 'showPrevious', type: 'checkbox', label: 'Show previous', default: true, category: 'behavior' },
      { name: 'showNext', type: 'checkbox', label: 'Show next', default: true, category: 'behavior' },
      { name: 'showMute', type: 'checkbox', label: 'Show mute', default: true, category: 'behavior' },
      { name: 'showStatus', type: 'checkbox', label: 'Show status text', default: true, category: 'behavior' },
      { name: 'buttonSize', type: 'number', label: 'Button size (px)', default: 40, min: 24, max: 96, category: 'style' },
      ...styleFields(MA_ACCENT),
    ],
  };
}

export function maVolumeSliderMetadata(): WidgetMetadata {
  return {
    name: 'MA Volume Slider',
    icon: 'VolumeUp',
    category: 'media',
    description: 'Slider that sets a Music Assistant player volume',
    defaultSize: { w: 280, h: 70 },
    minSize: { w: 120, h: 50 },
    requiresEntity: false,
    fields: [
      playerField(),
      pollField(),
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
      { name: 'fillColor', type: 'color', label: 'Fill colour', default: MA_ACCENT, category: 'style' },
      { name: 'thumbColor', type: 'color', label: 'Thumb colour', default: MA_ACCENT, category: 'style' },
      { name: 'backgroundColor', type: 'color', label: 'Background', default: '#12161f', category: 'style' },
      { name: 'textColor', type: 'color', label: 'Text colour', default: '#e6edf3', category: 'style' },
      { name: 'borderRadius', type: 'number', label: 'Corner radius', default: 12, min: 0, max: 40, category: 'style' },
    ],
  };
}

export function maVolumeDialMetadata(): WidgetMetadata {
  return {
    name: 'MA Volume Dial',
    icon: 'DialpadOutlined',
    category: 'media',
    description: 'Rotary dial that sets a Music Assistant player volume',
    defaultSize: { w: 170, h: 170 },
    minSize: { w: 90, h: 90 },
    requiresEntity: false,
    fields: [
      playerField(),
      pollField(),
      { name: 'label', type: 'text', label: 'Label', default: 'Volume', category: 'behavior' },
      { name: 'showValue', type: 'checkbox', label: 'Show value', default: true, category: 'behavior' },
      { name: 'showMute', type: 'checkbox', label: 'Show mute button', default: true, category: 'behavior' },
      { name: 'angleOffset', type: 'number', label: 'Angle offset (°)', default: 220, min: 0, max: 360, category: 'behavior' },
      { name: 'angleRange', type: 'number', label: 'Angle range (°)', default: 280, min: 0, max: 360, category: 'behavior' },
      { name: 'knobColor', type: 'color', label: 'Knob colour', default: '#1f2733', category: 'style' },
      { name: 'trackColor', type: 'color', label: 'Track colour', default: '#2a3444', category: 'style' },
      { name: 'fillColor', type: 'color', label: 'Fill colour', default: MA_ACCENT, category: 'style' },
      { name: 'textColor', type: 'color', label: 'Text colour', default: '#e6edf3', category: 'style' },
      { name: 'backgroundColor', type: 'color', label: 'Background', default: '#12161f', category: 'style' },
      { name: 'borderRadius', type: 'number', label: 'Corner radius', default: 12, min: 0, max: 40, category: 'style' },
    ],
  };
}

export function maRadiosMetadata(): WidgetMetadata {
  return {
    name: 'MA Radio Stations',
    icon: 'Radio',
    category: 'media',
    description: 'Music Assistant radio stations (includes the DAB+ SDR provider) — tap to play on the target player',
    defaultSize: { w: 300, h: 320 },
    minSize: { w: 160, h: 120 },
    requiresEntity: false,
    fields: [
      playerField('Play on player'),
      pollField(30),
      { name: 'title', type: 'text', label: 'Header title', default: 'Radio', category: 'behavior' },
      { name: 'showHeader', type: 'checkbox', label: 'Show header', default: true, category: 'behavior' },
      { name: 'search', type: 'text', label: 'Filter (substring)', default: '', category: 'behavior' },
      { name: 'maxItems', type: 'number', label: 'Max items', default: 200, min: 1, max: 1000, category: 'behavior' },
      ...styleFields(MA_ACCENT),
    ],
  };
}

export function maPlaylistsMetadata(): WidgetMetadata {
  return {
    name: 'MA Playlists',
    icon: 'QueueMusic',
    category: 'media',
    description: 'Music Assistant playlists — tap to play on the target player',
    defaultSize: { w: 300, h: 320 },
    minSize: { w: 160, h: 120 },
    requiresEntity: false,
    fields: [
      playerField('Play on player'),
      pollField(30),
      { name: 'title', type: 'text', label: 'Header title', default: 'Playlists', category: 'behavior' },
      { name: 'showHeader', type: 'checkbox', label: 'Show header', default: true, category: 'behavior' },
      { name: 'maxItems', type: 'number', label: 'Max items', default: 100, min: 1, max: 500, category: 'behavior' },
      ...styleFields(MA_ACCENT),
    ],
  };
}

export function maSearchMetadata(): WidgetMetadata {
  return {
    name: 'MA Search',
    icon: 'Search',
    category: 'media',
    description: 'Search the Music Assistant library and play a result on the target player',
    defaultSize: { w: 320, h: 320 },
    minSize: { w: 180, h: 140 },
    requiresEntity: false,
    fields: [
      playerField('Play on player'),
      { name: 'resultLimit', type: 'number', label: 'Result limit', default: 20, min: 5, max: 50, category: 'behavior' },
      { name: 'placeholder', type: 'text', label: 'Placeholder', default: 'Search music…', category: 'behavior' },
      ...styleFields(MA_ACCENT),
    ],
  };
}
