/**
 * UPnP device + service descriptions for the Canvas Display DLNA renderer.
 *
 * Home Assistant's `dlna_dmr` integration discovers a renderer over SSDP and
 * then fetches this device description. It must advertise the three standard
 * MediaRenderer services with their SCPDs, otherwise HA refuses the device.
 */

import { escapeXml } from './xml';

export const AV_TRANSPORT_TYPE = 'urn:schemas-upnp-org:service:AVTransport:1';
export const RENDERING_CONTROL_TYPE = 'urn:schemas-upnp-org:service:RenderingControl:1';
export const CONNECTION_MANAGER_TYPE = 'urn:schemas-upnp-org:service:ConnectionManager:1';

export const AV_TRANSPORT_ID = 'urn:upnp-org:serviceId:AVTransport';
export const RENDERING_CONTROL_ID = 'urn:upnp-org:serviceId:RenderingControl';
export const CONNECTION_MANAGER_ID = 'urn:upnp-org:serviceId:ConnectionManager';

export const MEDIA_RENDERER_TYPE = 'urn:schemas-upnp-org:device:MediaRenderer:1';

export interface DlnaDescriptionConfig {
  uuid: string;
  friendlyName: string;
  manufacturer: string;
  modelName: string;
  modelNumber: string;
  /** Absolute base URL, e.g. `http://192.168.1.216:49500`. */
  baseUrl: string;
}

interface ServiceDescriptor {
  serviceType: string;
  serviceId: string;
  scpdPath: string;
  controlPath: string;
  eventPath: string;
}

const SERVICES: ServiceDescriptor[] = [
  {
    serviceType: AV_TRANSPORT_TYPE,
    serviceId: AV_TRANSPORT_ID,
    scpdPath: '/service/AVTransport.xml',
    controlPath: '/control/AVTransport',
    eventPath: '/event/AVTransport',
  },
  {
    serviceType: RENDERING_CONTROL_TYPE,
    serviceId: RENDERING_CONTROL_ID,
    scpdPath: '/service/RenderingControl.xml',
    controlPath: '/control/RenderingControl',
    eventPath: '/event/RenderingControl',
  },
  {
    serviceType: CONNECTION_MANAGER_TYPE,
    serviceId: CONNECTION_MANAGER_ID,
    scpdPath: '/service/ConnectionManager.xml',
    controlPath: '/control/ConnectionManager',
    eventPath: '/event/ConnectionManager',
  },
];

/** Build the root device description served at `/description.xml`. */
export function buildDeviceDescription(cfg: DlnaDescriptionConfig): string {
  const services = SERVICES.map(
    (service) =>
      '<service>' +
      `<serviceType>${service.serviceType}</serviceType>` +
      `<serviceId>${service.serviceId}</serviceId>` +
      `<SCPDURL>${service.scpdPath}</SCPDURL>` +
      `<controlURL>${service.controlPath}</controlURL>` +
      `<eventSubURL>${service.eventPath}</eventSubURL>` +
      '</service>',
  ).join('');

  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<root xmlns="urn:schemas-upnp-org:device-1-0">' +
    '<specVersion><major>1</major><minor>0</minor></specVersion>' +
    '<device>' +
    `<deviceType>${MEDIA_RENDERER_TYPE}</deviceType>` +
    `<friendlyName>${escapeXml(cfg.friendlyName)}</friendlyName>` +
    `<manufacturer>${escapeXml(cfg.manufacturer)}</manufacturer>` +
    '<manufacturerURL>https://github.com/canvas-display</manufacturerURL>' +
    '<modelDescription>Canvas Display DLNA media renderer</modelDescription>' +
    `<modelName>${escapeXml(cfg.modelName)}</modelName>` +
    `<modelNumber>${escapeXml(cfg.modelNumber)}</modelNumber>` +
    `<UDN>uuid:${escapeXml(cfg.uuid)}</UDN>` +
    '<dlna:X_DLNADOC xmlns:dlna="urn:schemas-dlna-org:device-1-0">DMR-1.50</dlna:X_DLNADOC>' +
    `<serviceList>${services}</serviceList>` +
    '</device>' +
    '</root>'
  );
}

/** Return the SCPD document for a service, or null when the path is unknown. */
export function buildServiceDescription(path: string): string | null {
  switch (path) {
    case '/service/AVTransport.xml':
      return avTransportScpd();
    case '/service/RenderingControl.xml':
      return renderingControlScpd();
    case '/service/ConnectionManager.xml':
      return connectionManagerScpd();
    default:
      return null;
  }
}

// ─── SCPD builders ────────────────────────────────────────────────────────────

interface ActionArg {
  name: string;
  direction: 'in' | 'out';
  stateVariable: string;
}

interface ActionDef {
  name: string;
  args: ActionArg[];
}

interface StateVariableDef {
  name: string;
  dataType: string;
  sendEvents?: boolean;
  allowedValues?: string[];
  defaultValue?: string;
}

function buildScpd(actions: ActionDef[], variables: StateVariableDef[]): string {
  const actionXml = actions
    .map((action) => {
      if (action.args.length === 0) return `<action><name>${action.name}</name></action>`;
      const args = action.args
        .map(
          (arg) =>
            '<argument>' +
            `<name>${arg.name}</name>` +
            `<direction>${arg.direction}</direction>` +
            `<relatedStateVariable>${arg.stateVariable}</relatedStateVariable>` +
            '</argument>',
        )
        .join('');
      return `<action><name>${action.name}</name><argumentList>${args}</argumentList></action>`;
    })
    .join('');

  const variableXml = variables
    .map((variable) => {
      const allowed = variable.allowedValues
        ? `<allowedValueList>${variable.allowedValues
            .map((value) => `<allowedValue>${escapeXml(value)}</allowedValue>`)
            .join('')}</allowedValueList>`
        : '';
      const defaultValue = variable.defaultValue
        ? `<defaultValue>${escapeXml(variable.defaultValue)}</defaultValue>`
        : '';
      return (
        '<stateVariable sendEvents="' +
        (variable.sendEvents ? 'yes' : 'no') +
        '">' +
        `<name>${variable.name}</name>` +
        `<dataType>${variable.dataType}</dataType>` +
        defaultValue +
        allowed +
        '</stateVariable>'
      );
    })
    .join('');

  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<scpd xmlns="urn:schemas-upnp-org:service-1-0">' +
    '<specVersion><major>1</major><minor>0</minor></specVersion>' +
    `<actionList>${actionXml}</actionList>` +
    `<serviceStateTable>${variableXml}</serviceStateTable>` +
    '</scpd>'
  );
}

function avTransportScpd(): string {
  const actions: ActionDef[] = [
    {
      name: 'SetAVTransportURI',
      args: [
        { name: 'InstanceID', direction: 'in', stateVariable: 'A_ARG_TYPE_InstanceID' },
        { name: 'CurrentURI', direction: 'in', stateVariable: 'AVTransportURI' },
        { name: 'CurrentURIMetaData', direction: 'in', stateVariable: 'AVTransportURIMetaData' },
      ],
    },
    {
      name: 'SetNextAVTransportURI',
      args: [
        { name: 'InstanceID', direction: 'in', stateVariable: 'A_ARG_TYPE_InstanceID' },
        { name: 'NextURI', direction: 'in', stateVariable: 'NextAVTransportURI' },
        { name: 'NextURIMetaData', direction: 'in', stateVariable: 'NextAVTransportURIMetaData' },
      ],
    },
    {
      name: 'GetMediaInfo',
      args: [
        { name: 'InstanceID', direction: 'in', stateVariable: 'A_ARG_TYPE_InstanceID' },
        { name: 'NrTracks', direction: 'out', stateVariable: 'NumberOfTracks' },
        { name: 'MediaDuration', direction: 'out', stateVariable: 'CurrentMediaDuration' },
        { name: 'CurrentURI', direction: 'out', stateVariable: 'AVTransportURI' },
        { name: 'CurrentURIMetaData', direction: 'out', stateVariable: 'AVTransportURIMetaData' },
        { name: 'NextURI', direction: 'out', stateVariable: 'NextAVTransportURI' },
        { name: 'NextURIMetaData', direction: 'out', stateVariable: 'NextAVTransportURIMetaData' },
        { name: 'PlayMedium', direction: 'out', stateVariable: 'PlaybackStorageMedium' },
        { name: 'RecordMedium', direction: 'out', stateVariable: 'RecordStorageMedium' },
        { name: 'WriteStatus', direction: 'out', stateVariable: 'RecordMediumWriteStatus' },
      ],
    },
    {
      name: 'GetTransportInfo',
      args: [
        { name: 'InstanceID', direction: 'in', stateVariable: 'A_ARG_TYPE_InstanceID' },
        { name: 'CurrentTransportState', direction: 'out', stateVariable: 'TransportState' },
        { name: 'CurrentTransportStatus', direction: 'out', stateVariable: 'TransportStatus' },
        { name: 'CurrentSpeed', direction: 'out', stateVariable: 'TransportPlaySpeed' },
      ],
    },
    {
      name: 'GetPositionInfo',
      args: [
        { name: 'InstanceID', direction: 'in', stateVariable: 'A_ARG_TYPE_InstanceID' },
        { name: 'Track', direction: 'out', stateVariable: 'CurrentTrack' },
        { name: 'TrackDuration', direction: 'out', stateVariable: 'CurrentTrackDuration' },
        { name: 'TrackMetaData', direction: 'out', stateVariable: 'CurrentTrackMetaData' },
        { name: 'TrackURI', direction: 'out', stateVariable: 'CurrentTrackURI' },
        { name: 'RelTime', direction: 'out', stateVariable: 'RelativeTimePosition' },
        { name: 'AbsTime', direction: 'out', stateVariable: 'AbsoluteTimePosition' },
        { name: 'RelCount', direction: 'out', stateVariable: 'RelativeCounterPosition' },
        { name: 'AbsCount', direction: 'out', stateVariable: 'AbsoluteCounterPosition' },
      ],
    },
    {
      name: 'GetDeviceCapabilities',
      args: [
        { name: 'InstanceID', direction: 'in', stateVariable: 'A_ARG_TYPE_InstanceID' },
        { name: 'PlayMedia', direction: 'out', stateVariable: 'PossiblePlaybackStorageMedia' },
        { name: 'RecMedia', direction: 'out', stateVariable: 'PossibleRecordStorageMedia' },
        { name: 'RecQualityModes', direction: 'out', stateVariable: 'PossibleRecordQualityModes' },
      ],
    },
    {
      name: 'GetTransportSettings',
      args: [
        { name: 'InstanceID', direction: 'in', stateVariable: 'A_ARG_TYPE_InstanceID' },
        { name: 'PlayMode', direction: 'out', stateVariable: 'CurrentPlayMode' },
        { name: 'RecQualityMode', direction: 'out', stateVariable: 'CurrentRecordQualityMode' },
      ],
    },
    { name: 'Stop', args: [{ name: 'InstanceID', direction: 'in', stateVariable: 'A_ARG_TYPE_InstanceID' }] },
    {
      name: 'Play',
      args: [
        { name: 'InstanceID', direction: 'in', stateVariable: 'A_ARG_TYPE_InstanceID' },
        { name: 'Speed', direction: 'in', stateVariable: 'TransportPlaySpeed' },
      ],
    },
    { name: 'Pause', args: [{ name: 'InstanceID', direction: 'in', stateVariable: 'A_ARG_TYPE_InstanceID' }] },
    {
      name: 'Seek',
      args: [
        { name: 'InstanceID', direction: 'in', stateVariable: 'A_ARG_TYPE_InstanceID' },
        { name: 'Unit', direction: 'in', stateVariable: 'A_ARG_TYPE_SeekMode' },
        { name: 'Target', direction: 'in', stateVariable: 'A_ARG_TYPE_SeekTarget' },
      ],
    },
    { name: 'Next', args: [{ name: 'InstanceID', direction: 'in', stateVariable: 'A_ARG_TYPE_InstanceID' }] },
    { name: 'Previous', args: [{ name: 'InstanceID', direction: 'in', stateVariable: 'A_ARG_TYPE_InstanceID' }] },
    {
      name: 'SetPlayMode',
      args: [
        { name: 'InstanceID', direction: 'in', stateVariable: 'A_ARG_TYPE_InstanceID' },
        { name: 'NewPlayMode', direction: 'in', stateVariable: 'CurrentPlayMode' },
      ],
    },
    {
      name: 'GetCurrentTransportActions',
      args: [
        { name: 'InstanceID', direction: 'in', stateVariable: 'A_ARG_TYPE_InstanceID' },
        { name: 'Actions', direction: 'out', stateVariable: 'CurrentTransportActions' },
      ],
    },
  ];

  const variables: StateVariableDef[] = [
    { name: 'A_ARG_TYPE_InstanceID', dataType: 'ui4' },
    { name: 'AVTransportURI', dataType: 'string' },
    { name: 'AVTransportURIMetaData', dataType: 'string' },
    { name: 'NextAVTransportURI', dataType: 'string' },
    { name: 'NextAVTransportURIMetaData', dataType: 'string' },
    { name: 'NumberOfTracks', dataType: 'ui4' },
    { name: 'CurrentMediaDuration', dataType: 'string' },
    { name: 'PlaybackStorageMedium', dataType: 'string' },
    { name: 'RecordStorageMedium', dataType: 'string' },
    { name: 'RecordMediumWriteStatus', dataType: 'string' },
    {
      name: 'TransportState',
      dataType: 'string',
      sendEvents: true,
      allowedValues: ['STOPPED', 'PLAYING', 'PAUSED_PLAYBACK', 'TRANSITIONING', 'NO_MEDIA_PRESENT'],
    },
    { name: 'TransportStatus', dataType: 'string', allowedValues: ['OK', 'ERROR_OCCURRED'] },
    { name: 'TransportPlaySpeed', dataType: 'string', allowedValues: ['1'] },
    { name: 'CurrentTrack', dataType: 'ui4' },
    { name: 'CurrentTrackDuration', dataType: 'string' },
    { name: 'CurrentTrackMetaData', dataType: 'string' },
    { name: 'CurrentTrackURI', dataType: 'string' },
    { name: 'RelativeTimePosition', dataType: 'string' },
    { name: 'AbsoluteTimePosition', dataType: 'string' },
    { name: 'RelativeCounterPosition', dataType: 'i4' },
    { name: 'AbsoluteCounterPosition', dataType: 'i4' },
    { name: 'PossiblePlaybackStorageMedia', dataType: 'string' },
    { name: 'PossibleRecordStorageMedia', dataType: 'string' },
    { name: 'PossibleRecordQualityModes', dataType: 'string' },
    { name: 'CurrentPlayMode', dataType: 'string', allowedValues: ['NORMAL'], defaultValue: 'NORMAL' },
    { name: 'CurrentRecordQualityMode', dataType: 'string' },
    { name: 'A_ARG_TYPE_SeekMode', dataType: 'string', allowedValues: ['REL_TIME', 'TRACK_NR'] },
    { name: 'A_ARG_TYPE_SeekTarget', dataType: 'string' },
    { name: 'CurrentTransportActions', dataType: 'string' },
    { name: 'LastChange', dataType: 'string', sendEvents: true },
  ];

  return buildScpd(actions, variables);
}

function renderingControlScpd(): string {
  const actions: ActionDef[] = [
    {
      name: 'ListPresets',
      args: [
        { name: 'InstanceID', direction: 'in', stateVariable: 'A_ARG_TYPE_InstanceID' },
        { name: 'CurrentPresetNameList', direction: 'out', stateVariable: 'PresetNameList' },
      ],
    },
    {
      name: 'SelectPreset',
      args: [
        { name: 'InstanceID', direction: 'in', stateVariable: 'A_ARG_TYPE_InstanceID' },
        { name: 'PresetName', direction: 'in', stateVariable: 'A_ARG_TYPE_PresetName' },
      ],
    },
    {
      name: 'GetVolume',
      args: [
        { name: 'InstanceID', direction: 'in', stateVariable: 'A_ARG_TYPE_InstanceID' },
        { name: 'Channel', direction: 'in', stateVariable: 'A_ARG_TYPE_Channel' },
        { name: 'CurrentVolume', direction: 'out', stateVariable: 'Volume' },
      ],
    },
    {
      name: 'SetVolume',
      args: [
        { name: 'InstanceID', direction: 'in', stateVariable: 'A_ARG_TYPE_InstanceID' },
        { name: 'Channel', direction: 'in', stateVariable: 'A_ARG_TYPE_Channel' },
        { name: 'DesiredVolume', direction: 'in', stateVariable: 'Volume' },
      ],
    },
    {
      name: 'GetMute',
      args: [
        { name: 'InstanceID', direction: 'in', stateVariable: 'A_ARG_TYPE_InstanceID' },
        { name: 'Channel', direction: 'in', stateVariable: 'A_ARG_TYPE_Channel' },
        { name: 'CurrentMute', direction: 'out', stateVariable: 'Mute' },
      ],
    },
    {
      name: 'SetMute',
      args: [
        { name: 'InstanceID', direction: 'in', stateVariable: 'A_ARG_TYPE_InstanceID' },
        { name: 'Channel', direction: 'in', stateVariable: 'A_ARG_TYPE_Channel' },
        { name: 'DesiredMute', direction: 'in', stateVariable: 'Mute' },
      ],
    },
  ];

  const variables: StateVariableDef[] = [
    { name: 'A_ARG_TYPE_InstanceID', dataType: 'ui4' },
    { name: 'A_ARG_TYPE_Channel', dataType: 'string', allowedValues: ['Master'] },
    { name: 'A_ARG_TYPE_PresetName', dataType: 'string', allowedValues: ['FactoryDefaults'] },
    { name: 'PresetNameList', dataType: 'string' },
    { name: 'Volume', dataType: 'ui2', sendEvents: true, defaultValue: '75' },
    { name: 'Mute', dataType: 'boolean', sendEvents: true, defaultValue: '0' },
    { name: 'LastChange', dataType: 'string', sendEvents: true },
  ];

  return buildScpd(actions, variables);
}

function connectionManagerScpd(): string {
  const actions: ActionDef[] = [
    {
      name: 'GetProtocolInfo',
      args: [
        { name: 'Source', direction: 'out', stateVariable: 'SourceProtocolInfo' },
        { name: 'Sink', direction: 'out', stateVariable: 'SinkProtocolInfo' },
      ],
    },
    {
      name: 'GetCurrentConnectionIDs',
      args: [{ name: 'ConnectionIDs', direction: 'out', stateVariable: 'CurrentConnectionIDs' }],
    },
    {
      name: 'GetCurrentConnectionInfo',
      args: [
        { name: 'ConnectionID', direction: 'in', stateVariable: 'A_ARG_TYPE_ConnectionID' },
        { name: 'RcsID', direction: 'out', stateVariable: 'A_ARG_TYPE_RcsID' },
        { name: 'AVTransportID', direction: 'out', stateVariable: 'A_ARG_TYPE_AVTransportID' },
        { name: 'ProtocolInfo', direction: 'out', stateVariable: 'A_ARG_TYPE_ProtocolInfo' },
        { name: 'PeerConnectionManager', direction: 'out', stateVariable: 'A_ARG_TYPE_ConnectionManager' },
        { name: 'PeerConnectionID', direction: 'out', stateVariable: 'A_ARG_TYPE_ConnectionID' },
        { name: 'Direction', direction: 'out', stateVariable: 'A_ARG_TYPE_Direction' },
        { name: 'Status', direction: 'out', stateVariable: 'A_ARG_TYPE_ConnectionStatus' },
      ],
    },
  ];

  const variables: StateVariableDef[] = [
    { name: 'SourceProtocolInfo', dataType: 'string', sendEvents: true },
    { name: 'SinkProtocolInfo', dataType: 'string', sendEvents: true },
    { name: 'CurrentConnectionIDs', dataType: 'string', sendEvents: true },
    { name: 'A_ARG_TYPE_ConnectionStatus', dataType: 'string' },
    { name: 'A_ARG_TYPE_ConnectionManager', dataType: 'string' },
    { name: 'A_ARG_TYPE_Direction', dataType: 'string' },
    { name: 'A_ARG_TYPE_ProtocolInfo', dataType: 'string' },
    { name: 'A_ARG_TYPE_ConnectionID', dataType: 'i4' },
    { name: 'A_ARG_TYPE_AVTransportID', dataType: 'i4' },
    { name: 'A_ARG_TYPE_RcsID', dataType: 'i4' },
  ];

  return buildScpd(actions, variables);
}

/**
 * The `Sink` protocol list advertised by ConnectionManager. Declaring both
 * audio and video MIME types is what lets a controller (Music Assistant, HA,
 * a phone's "cast" menu) push either kind of media at us.
 */
export const SINK_PROTOCOL_INFO = [
  'http-get:*:audio/mpeg:*',
  'http-get:*:audio/mp4:*',
  'http-get:*:audio/aac:*',
  'http-get:*:audio/aacp:*',
  'http-get:*:audio/flac:*',
  'http-get:*:audio/ogg:*',
  'http-get:*:audio/wav:*',
  'http-get:*:audio/x-wav:*',
  'http-get:*:audio/L16:*',
  'http-get:*:audio/webm:*',
  'http-get:*:video/mp4:*',
  'http-get:*:video/webm:*',
  'http-get:*:video/mpeg:*',
  'http-get:*:video/x-matroska:*',
  'http-get:*:video/quicktime:*',
  'http-get:*:application/vnd.apple.mpegurl:*',
  'http-get:*:application/x-mpegURL:*',
  'http-get:*:application/octet-stream:*',
].join(',');