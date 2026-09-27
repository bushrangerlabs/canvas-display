/**
 * DLNA MediaRenderer state machine.
 *
 * Owns the AVTransport / RenderingControl / ConnectionManager state and maps
 * UPnP actions onto a small playback adapter. The adapter is injected so the
 * renderer stays testable and the sidecar can wire audio to mpv and video to
 * the kiosk's floating WebView.
 */

import {
  AV_TRANSPORT_TYPE,
  RENDERING_CONTROL_TYPE,
  CONNECTION_MANAGER_TYPE,
  SINK_PROTOCOL_INFO,
} from './descriptions';
import {
  DidlMetadata,
  escapeXml,
  formatUpnpDuration,
  parseDidlLite,
  parseUpnpDuration,
} from './xml';

export type TransportState =
  | 'STOPPED'
  | 'PLAYING'
  | 'PAUSED_PLAYBACK'
  | 'TRANSITIONING'
  | 'NO_MEDIA_PRESENT';

export interface DlnaPlaybackAdapter {
  playAudio(input: { url: string; title?: string; volume?: number }): Promise<void>;
  pauseAudio(): Promise<void>;
  resumeAudio(): Promise<void>;
  stopAudio(): Promise<void>;
  seekAudio(seconds: number): Promise<void>;
  setVolume(level: number): Promise<void>;
  setMute(muted: boolean): Promise<void>;
  getVolume(): number;
  getMuted(): boolean;
  playVideo(url: string, title?: string): void;
  stopVideo(): void;
}

/** A UPnP action error carrying the standard error code + description. */
export class UpnpError extends Error {
  constructor(public readonly code: number, public readonly description: string) {
    super(description);
    this.name = 'UpnpError';
  }
}

export interface DlnaSubscriber {
  sid: string;
  service: string;
  callbackUrl: string;
  expiresAt: number;
  seq: number;
}

export interface DlnaEventSender {
  (subscriber: DlnaSubscriber, body: string): void;
}

const VIDEO_EXTENSIONS = /\.(mp4|m4v|mkv|webm|mov|avi|mpe?g|ts|m3u8|mpd|ogv)(\?|$)/i;
const AUDIO_EXTENSIONS = /\.(mp3|m4a|aac|flac|ogg|oga|opus|wav|wma|mp2|m3u)(\?|$)/i;

export class DlnaRenderer {
  private transportState: TransportState = 'NO_MEDIA_PRESENT';
  private currentUri = '';
  private currentUriMetadata = '';
  private nextUri = '';
  private nextUriMetadata = '';
  private metadata: DidlMetadata = {};
  private durationSeconds = 0;
  private positionSeconds = 0;
  private positionUpdatedAt = Date.now();
  private playMode = 'NORMAL';
  private isVideo = false;
  private readonly subscribers = new Map<string, DlnaSubscriber>();

  constructor(
    private readonly adapter: DlnaPlaybackAdapter,
    private readonly eventSender?: DlnaEventSender,
  ) {}

  // ─── Introspection (used by the sidecar's own UI / tests) ───────────────────

  getState(): {
    transportState: TransportState;
    uri: string;
    title: string;
    artist?: string;
    album?: string;
    artworkUrl?: string;
    isVideo: boolean;
    durationSeconds: number;
    positionSeconds: number;
  } {
    return {
      transportState: this.transportState,
      uri: this.currentUri,
      title: this.metadata.title ?? '',
      artist: this.metadata.artist,
      album: this.metadata.album,
      artworkUrl: this.metadata.artworkUrl,
      isVideo: this.isVideo,
      durationSeconds: this.durationSeconds,
      positionSeconds: this.getPosition(),
    };
  }

  private getPosition(): number {
    if (this.transportState !== 'PLAYING') return this.positionSeconds;
    const elapsed = (Date.now() - this.positionUpdatedAt) / 1000;
    const position = this.positionSeconds + Math.max(0, elapsed);
    if (this.durationSeconds > 0) return Math.min(position, this.durationSeconds);
    return position;
  }

  private freezePosition(): void {
    this.positionSeconds = this.getPosition();
    this.positionUpdatedAt = Date.now();
  }

  // ─── Action dispatch ────────────────────────────────────────────────────────

  async handleAction(serviceType: string, action: string, args: Record<string, string>): Promise<string> {
    switch (serviceType) {
      case AV_TRANSPORT_TYPE:
        return this.handleAvTransport(action, args);
      case RENDERING_CONTROL_TYPE:
        return this.handleRenderingControl(action, args);
      case CONNECTION_MANAGER_TYPE:
        return this.handleConnectionManager(action, args);
      default:
        throw new UpnpError(401, 'Invalid Action');
    }
  }

  private async handleAvTransport(action: string, args: Record<string, string>): Promise<string> {
    switch (action) {
      case 'SetAVTransportURI':
        await this.setAvTransportUri(args.CurrentURI ?? '', args.CurrentURIMetaData ?? '');
        return '';
      case 'SetNextAVTransportURI':
        this.nextUri = args.NextURI ?? '';
        this.nextUriMetadata = args.NextURIMetaData ?? '';
        return '';
      case 'GetMediaInfo':
        return (
          `<NrTracks>${this.currentUri ? 1 : 0}</NrTracks>` +
          `<MediaDuration>${formatUpnpDuration(this.durationSeconds)}</MediaDuration>` +
          `<CurrentURI>${escapeXml(this.currentUri)}</CurrentURI>` +
          `<CurrentURIMetaData>${escapeXml(this.currentUriMetadata)}</CurrentURIMetaData>` +
          `<NextURI>${escapeXml(this.nextUri)}</NextURI>` +
          `<NextURIMetaData>${escapeXml(this.nextUriMetadata)}</NextURIMetaData>` +
          `<PlayMedium>NETWORK</PlayMedium>` +
          '<RecordMedium>NOT_IMPLEMENTED</RecordMedium>' +
          '<WriteStatus>NOT_IMPLEMENTED</WriteStatus>'
        );
      case 'GetTransportInfo':
        return (
          `<CurrentTransportState>${this.transportState}</CurrentTransportState>` +
          '<CurrentTransportStatus>OK</CurrentTransportStatus>' +
          '<CurrentSpeed>1</CurrentSpeed>'
        );
      case 'GetPositionInfo': {
        const position = this.getPosition();
        return (
          '<Track>1</Track>' +
          `<TrackDuration>${formatUpnpDuration(this.durationSeconds)}</TrackDuration>` +
          `<TrackMetaData>${escapeXml(this.currentUriMetadata)}</TrackMetaData>` +
          `<TrackURI>${escapeXml(this.currentUri)}</TrackURI>` +
          `<RelTime>${formatUpnpDuration(position)}</RelTime>` +
          `<AbsTime>${formatUpnpDuration(position)}</AbsTime>` +
          '<RelCount>2147483647</RelCount>' +
          '<AbsCount>2147483647</AbsCount>'
        );
      }
      case 'GetDeviceCapabilities':
        return (
          '<PlayMedia>NETWORK,NONE</PlayMedia>' +
          '<RecMedia>NOT_IMPLEMENTED</RecMedia>' +
          '<RecQualityModes>NOT_IMPLEMENTED</RecQualityModes>'
        );
      case 'GetTransportSettings':
        return `<PlayMode>${this.playMode}</PlayMode><RecQualityMode>NOT_IMPLEMENTED</RecQualityMode>`;
      case 'Stop':
        await this.stop();
        return '';
      case 'Play':
        await this.play();
        return '';
      case 'Pause':
        await this.pause();
        return '';
      case 'Seek':
        await this.seek(args.Unit ?? 'REL_TIME', args.Target ?? '');
        return '';
      case 'Next':
      case 'Previous':
        // No queue: accept the action without changing playback.
        return '';
      case 'SetPlayMode':
        this.playMode = args.NewPlayMode || 'NORMAL';
        return '';
      case 'GetCurrentTransportActions':
        return `<Actions>${this.currentActions()}</Actions>`;
      default:
        throw new UpnpError(401, 'Invalid Action');
    }
  }

  private currentActions(): string {
    switch (this.transportState) {
      case 'PLAYING':
        return 'Stop,Pause,Seek,Play';
      case 'PAUSED_PLAYBACK':
        return 'Stop,Play,Seek';
      case 'STOPPED':
        return 'Play,Seek';
      default:
        return 'Play';
    }
  }

  private async handleRenderingControl(action: string, args: Record<string, string>): Promise<string> {
    switch (action) {
      case 'ListPresets':
        return '<CurrentPresetNameList>FactoryDefaults</CurrentPresetNameList>';
      case 'SelectPreset':
        return '';
      case 'GetVolume':
        return `<CurrentVolume>${Math.round(this.adapter.getVolume())}</CurrentVolume>`;
      case 'SetVolume': {
        const desired = Number(args.DesiredVolume);
        if (!Number.isFinite(desired)) throw new UpnpError(402, 'Invalid Args');
        await this.adapter.setVolume(Math.max(0, Math.min(100, desired)));
        this.emitChange(RENDERING_CONTROL_TYPE);
        return '';
      }
      case 'GetMute':
        return `<CurrentMute>${this.adapter.getMuted() ? 1 : 0}</CurrentMute>`;
      case 'SetMute': {
        const desired = String(args.DesiredMute ?? '').toLowerCase();
        const muted = desired === '1' || desired === 'true' || desired === 'yes';
        await this.adapter.setMute(muted);
        this.emitChange(RENDERING_CONTROL_TYPE);
        return '';
      }
      default:
        throw new UpnpError(401, 'Invalid Action');
    }
  }

  private async handleConnectionManager(action: string, _args: Record<string, string>): Promise<string> {
    switch (action) {
      case 'GetProtocolInfo':
        return `<Source></Source><Sink>${escapeXml(SINK_PROTOCOL_INFO)}</Sink>`;
      case 'GetCurrentConnectionIDs':
        return '<ConnectionIDs>0</ConnectionIDs>';
      case 'GetCurrentConnectionInfo':
        return (
          '<RcsID>0</RcsID>' +
          '<AVTransportID>0</AVTransportID>' +
          `<ProtocolInfo>${escapeXml(this.metadata.mimeType ? `http-get:*:${this.metadata.mimeType}:*` : '')}</ProtocolInfo>` +
          '<PeerConnectionManager></PeerConnectionManager>' +
          '<PeerConnectionID>-1</PeerConnectionID>' +
          '<Direction>Input</Direction>' +
          '<Status>OK</Status>'
        );
      default:
        throw new UpnpError(401, 'Invalid Action');
    }
  }

  // ─── Transport operations ───────────────────────────────────────────────────

  private async setAvTransportUri(uri: string, metadataXml: string): Promise<void> {
    this.currentUri = uri;
    this.currentUriMetadata = metadataXml;
    this.metadata = parseDidlLite(metadataXml);
    this.durationSeconds = this.metadata.durationSeconds ?? 0;
    this.positionSeconds = 0;
    this.positionUpdatedAt = Date.now();
    this.isVideo = this.detectVideo(uri, this.metadata);
    this.transportState = uri ? 'STOPPED' : 'NO_MEDIA_PRESENT';
    this.emitChange(AV_TRANSPORT_TYPE);
  }

  private detectVideo(uri: string, metadata: DidlMetadata): boolean {
    const mime = (metadata.mimeType ?? '').toLowerCase();
    if (mime.startsWith('video/')) return true;
    if (mime.startsWith('audio/')) return false;
    if (metadata.upnpClass?.includes('videoItem')) return true;
    if (metadata.upnpClass?.includes('audioItem')) return false;
    if (VIDEO_EXTENSIONS.test(uri)) return true;
    if (AUDIO_EXTENSIONS.test(uri)) return false;
    return false;
  }

  private async play(): Promise<void> {
    if (!this.currentUri) throw new UpnpError(701, 'Transition not available');

    if (this.transportState === 'PAUSED_PLAYBACK') {
      if (this.isVideo) {
        // The kiosk WebView keeps its own pause state; re-open to resume.
        this.adapter.playVideo(this.currentUri, this.metadata.title);
      } else {
        await this.adapter.resumeAudio();
      }
    } else {
      if (this.isVideo) {
        this.adapter.playVideo(this.currentUri, this.metadata.title);
      } else {
        await this.adapter.playAudio({
          url: this.currentUri,
          title: this.metadata.title,
          volume: Math.round(this.adapter.getVolume()),
        });
      }
    }

    this.transportState = 'PLAYING';
    this.positionUpdatedAt = Date.now();
    this.emitChange(AV_TRANSPORT_TYPE);
  }

  private async pause(): Promise<void> {
    if (this.transportState !== 'PLAYING') throw new UpnpError(701, 'Transition not available');
    this.freezePosition();
    if (this.isVideo) {
      this.adapter.stopVideo();
    } else {
      await this.adapter.pauseAudio();
    }
    this.transportState = 'PAUSED_PLAYBACK';
    this.emitChange(AV_TRANSPORT_TYPE);
  }

  private async stop(): Promise<void> {
    if (this.isVideo) {
      this.adapter.stopVideo();
    } else {
      await this.adapter.stopAudio().catch(() => undefined);
    }
    this.positionSeconds = 0;
    this.positionUpdatedAt = Date.now();
    this.transportState = this.currentUri ? 'STOPPED' : 'NO_MEDIA_PRESENT';
    this.emitChange(AV_TRANSPORT_TYPE);
  }

  private async seek(unit: string, target: string): Promise<void> {
    if (!this.currentUri) throw new UpnpError(701, 'Transition not available');
    if (unit !== 'REL_TIME') throw new UpnpError(710, 'Seek mode not supported');

    const seconds = parseUpnpDuration(target);
    if (seconds === undefined) throw new UpnpError(711, 'Illegal seek target');

    this.positionSeconds = seconds;
    this.positionUpdatedAt = Date.now();
    if (!this.isVideo) {
      await this.adapter.seekAudio(seconds).catch(() => undefined);
    }
    this.emitChange(AV_TRANSPORT_TYPE);
  }

  // ─── GENA eventing ──────────────────────────────────────────────────────────

  subscribe(service: string, callbackUrl: string, timeoutSeconds: number): DlnaSubscriber {
    const sid = `uuid:${randomSid()}`;
    const subscriber: DlnaSubscriber = {
      sid,
      service,
      callbackUrl,
      expiresAt: Date.now() + Math.max(30, timeoutSeconds) * 1000,
      seq: 0,
    };
    this.subscribers.set(sid, subscriber);
    return subscriber;
  }

  renew(sid: string, timeoutSeconds: number): DlnaSubscriber | null {
    const subscriber = this.subscribers.get(sid);
    if (!subscriber) return null;
    subscriber.expiresAt = Date.now() + Math.max(30, timeoutSeconds) * 1000;
    return subscriber;
  }

  unsubscribe(sid: string): boolean {
    return this.subscribers.delete(sid);
  }

  pruneSubscribers(): void {
    const now = Date.now();
    for (const [sid, subscriber] of this.subscribers) {
      if (subscriber.expiresAt <= now) this.subscribers.delete(sid);
    }
  }

  /** Send the current state to a subscriber (the initial event after SUBSCRIBE). */
  sendInitialEvent(subscriber: DlnaSubscriber): void {
    this.dispatchEvent(subscriber);
  }

  private emitChange(serviceType: string): void {
    this.pruneSubscribers();
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.service === serviceType) this.dispatchEvent(subscriber);
    }
  }

  private dispatchEvent(subscriber: DlnaSubscriber): void {
    if (!this.eventSender) return;
    const body = subscriber.service === RENDERING_CONTROL_TYPE ? this.renderingControlEvent() : this.avTransportEvent();
    this.eventSender(subscriber, body);
  }

  private avTransportEvent(): string {
    const position = this.getPosition();
    const inner =
      `<TransportState val="${this.transportState}"/>` +
      `<TransportStatus val="OK"/>` +
      `<CurrentPlayMode val="${this.playMode}"/>` +
      `<CurrentTrack val="1"/>` +
      `<CurrentTrackDuration val="${formatUpnpDuration(this.durationSeconds)}"/>` +
      `<CurrentTrackURI val="${escapeXml(this.currentUri)}"/>` +
      `<CurrentTrackMetaData val="${escapeXml(this.currentUriMetadata)}"/>` +
      `<AVTransportURI val="${escapeXml(this.currentUri)}"/>` +
      `<AVTransportURIMetaData val="${escapeXml(this.currentUriMetadata)}"/>` +
      `<RelativeTimePosition val="${formatUpnpDuration(position)}"/>` +
      `<AbsoluteTimePosition val="${formatUpnpDuration(position)}"/>` +
      `<CurrentTransportActions val="${this.currentActions()}"/>`;
    return wrapLastChange('urn:schemas-upnp-org:metadata-1-0/AVT/', inner);
  }

  private renderingControlEvent(): string {
    const inner =
      `<Volume channel="Master" val="${Math.round(this.adapter.getVolume())}"/>` +
      `<Mute channel="Master" val="${this.adapter.getMuted() ? 1 : 0}"/>`;
    return wrapLastChange('urn:schemas-upnp-org:metadata-1-0/RCS/', inner);
  }
}

function wrapLastChange(namespace: string, inner: string): string {
  const event = `<Event xmlns="${namespace}"><InstanceID val="0">${inner}</InstanceID></Event>`;
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">' +
    `<e:property><LastChange>${escapeXml(event)}</LastChange></e:property>` +
    '</e:propertyset>'
  );
}

function randomSid(): string {
  // RFC 4122 v4-shaped identifier without pulling in a crypto dependency.
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-a${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}