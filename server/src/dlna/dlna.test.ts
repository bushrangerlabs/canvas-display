import assert from 'node:assert/strict';
import test from 'node:test';
import {
  escapeXml,
  formatUpnpDuration,
  parseDidlLite,
  parseSoapActionHeader,
  parseUpnpDuration,
  readElement,
  unescapeXml,
} from './xml';
import { DlnaRenderer, UpnpError, type DlnaPlaybackAdapter } from './renderer';
import {
  AV_TRANSPORT_TYPE,
  CONNECTION_MANAGER_TYPE,
  RENDERING_CONTROL_TYPE,
  buildDeviceDescription,
  buildServiceDescription,
} from './descriptions';

// ─── XML helpers ──────────────────────────────────────────────────────────────

test('escapeXml and unescapeXml round-trip special characters', () => {
  const raw = `Tom & Jerry's <"show">`;
  const escaped = escapeXml(raw);
  assert.equal(escaped, 'Tom &amp; Jerry&apos;s &lt;&quot;show&quot;&gt;');
  assert.equal(unescapeXml(escaped), raw);
});

test('unescapeXml decodes numeric character references', () => {
  assert.equal(unescapeXml('caf&#233; &#x1F600;'), 'café 😀');
});

test('readElement reads text and CDATA content', () => {
  assert.equal(readElement('<dc:title>Hello</dc:title>', 'dc:title'), 'Hello');
  assert.equal(readElement('<dc:title><![CDATA[A & B]]></dc:title>', 'dc:title'), 'A & B');
  assert.equal(readElement('<x/>', 'dc:title'), undefined);
});

test('parseUpnpDuration and formatUpnpDuration round-trip', () => {
  assert.equal(parseUpnpDuration('0:03:45'), 225);
  assert.equal(parseUpnpDuration('1:00:00.500'), 3600.5);
  assert.equal(parseUpnpDuration('garbage'), undefined);
  assert.equal(formatUpnpDuration(225), '0:03:45');
  assert.equal(formatUpnpDuration(-5), '0:00:00');
});

test('parseSoapActionHeader extracts service and action', () => {
  const parsed = parseSoapActionHeader('"urn:schemas-upnp-org:service:AVTransport:1#Play"');
  assert.deepEqual(parsed, { service: 'urn:schemas-upnp-org:service:AVTransport:1', action: 'Play' });
  assert.equal(parseSoapActionHeader('nonsense'), null);
  assert.equal(parseSoapActionHeader(undefined), null);
});

// ─── DIDL-Lite ────────────────────────────────────────────────────────────────

test('parseDidlLite extracts title, artist, album, artwork, mime and duration', () => {
  const didl =
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="1" parentID="0" restricted="1">' +
    '<dc:title>Bohemian Rhapsody</dc:title>' +
    '<upnp:artist>Queen</upnp:artist>' +
    '<upnp:album>A Night at the Opera</upnp:album>' +
    '<upnp:albumArtURI>http://192.168.1.108:8097/art.jpg</upnp:albumArtURI>' +
    '<upnp:class>object.item.audioItem.musicTrack</upnp:class>' +
    '<res protocolInfo="http-get:*:audio/mpeg:DLNA.ORG_PN=MP3" duration="0:05:55">http://host/track.mp3</res>' +
    '</item></DIDL-Lite>';

  const meta = parseDidlLite(didl);
  assert.equal(meta.title, 'Bohemian Rhapsody');
  assert.equal(meta.artist, 'Queen');
  assert.equal(meta.album, 'A Night at the Opera');
  assert.equal(meta.artworkUrl, 'http://192.168.1.108:8097/art.jpg');
  assert.equal(meta.mimeType, 'audio/mpeg');
  assert.equal(meta.durationSeconds, 355);
  assert.equal(meta.upnpClass, 'object.item.audioItem.musicTrack');
});

test('parseDidlLite returns an empty object for empty input', () => {
  assert.deepEqual(parseDidlLite(''), {});
  assert.deepEqual(parseDidlLite(undefined), {});
});

// ─── Descriptions ─────────────────────────────────────────────────────────────

test('device description advertises all three MediaRenderer services', () => {
  const xml = buildDeviceDescription({
    uuid: 'abc-123',
    friendlyName: 'Canvas Display (Pi)',
    manufacturer: 'Canvas Display',
    modelName: 'Canvas Display',
    modelNumber: '0.3.1',
    baseUrl: 'http://192.168.1.216:49500',
  });
  assert.match(xml, /<deviceType>urn:schemas-upnp-org:device:MediaRenderer:1<\/deviceType>/);
  assert.match(xml, /<UDN>uuid:abc-123<\/UDN>/);
  assert.match(xml, /urn:schemas-upnp-org:service:AVTransport:1/);
  assert.match(xml, /urn:schemas-upnp-org:service:RenderingControl:1/);
  assert.match(xml, /urn:schemas-upnp-org:service:ConnectionManager:1/);
  assert.match(xml, /<controlURL>\/control\/AVTransport<\/controlURL>/);
});

test('service descriptions exist for each control path and are well-formed', () => {
  for (const path of ['/service/AVTransport.xml', '/service/RenderingControl.xml', '/service/ConnectionManager.xml']) {
    const scpd = buildServiceDescription(path);
    assert.ok(scpd, `missing SCPD for ${path}`);
    assert.match(scpd!, /<scpd xmlns="urn:schemas-upnp-org:service-1-0">/);
    assert.match(scpd!, /<actionList>/);
    assert.match(scpd!, /<serviceStateTable>/);
  }
  assert.equal(buildServiceDescription('/service/Unknown.xml'), null);
});

// ─── Renderer ─────────────────────────────────────────────────────────────────

interface AdapterCalls {
  played: Array<{ url: string; title?: string }>;
  paused: number;
  resumed: number;
  stopped: number;
  seeks: number[];
  volumes: number[];
  mutes: boolean[];
  videos: string[];
  videoStops: number;
}

function makeAdapter(): { adapter: DlnaPlaybackAdapter; calls: AdapterCalls } {
  const calls: AdapterCalls = {
    played: [],
    paused: 0,
    resumed: 0,
    stopped: 0,
    seeks: [],
    volumes: [],
    mutes: [],
    videos: [],
    videoStops: 0,
  };
  let volume = 50;
  let muted = false;
  const adapter: DlnaPlaybackAdapter = {
    playAudio: async (input) => { calls.played.push({ url: input.url, title: input.title }); },
    pauseAudio: async () => { calls.paused += 1; },
    resumeAudio: async () => { calls.resumed += 1; },
    stopAudio: async () => { calls.stopped += 1; },
    seekAudio: async (seconds) => { calls.seeks.push(seconds); },
    setVolume: async (level) => { volume = level; calls.volumes.push(level); },
    setMute: async (value) => { muted = value; calls.mutes.push(value); },
    getVolume: () => volume,
    getMuted: () => muted,
    playVideo: (url) => { calls.videos.push(url); },
    stopVideo: () => { calls.videoStops += 1; },
  };
  return { adapter, calls };
}

const AUDIO_DIDL =
  '<DIDL-Lite><item><dc:title>Track</dc:title>' +
  '<upnp:class>object.item.audioItem.musicTrack</upnp:class>' +
  '<res protocolInfo="http-get:*:audio/mpeg:*" duration="0:02:00">http://host/a.mp3</res>' +
  '</item></DIDL-Lite>';

const VIDEO_DIDL =
  '<DIDL-Lite><item><dc:title>Clip</dc:title>' +
  '<upnp:class>object.item.videoItem</upnp:class>' +
  '<res protocolInfo="http-get:*:video/mp4:*" duration="0:01:30">http://host/v.mp4</res>' +
  '</item></DIDL-Lite>';

test('renderer starts with NO_MEDIA_PRESENT and reports transport info', async () => {
  const { adapter } = makeAdapter();
  const renderer = new DlnaRenderer(adapter);
  const info = await renderer.handleAction(AV_TRANSPORT_TYPE, 'GetTransportInfo', {});
  assert.match(info, /<CurrentTransportState>NO_MEDIA_PRESENT<\/CurrentTransportState>/);
});

test('SetAVTransportURI + Play routes audio to the adapter', async () => {
  const { adapter, calls } = makeAdapter();
  const renderer = new DlnaRenderer(adapter);

  await renderer.handleAction(AV_TRANSPORT_TYPE, 'SetAVTransportURI', {
    CurrentURI: 'http://host/a.mp3',
    CurrentURIMetaData: AUDIO_DIDL,
  });
  const mediaInfo = await renderer.handleAction(AV_TRANSPORT_TYPE, 'GetMediaInfo', {});
  assert.match(mediaInfo, /<CurrentURI>http:\/\/host\/a\.mp3<\/CurrentURI>/);
  assert.match(mediaInfo, /<MediaDuration>0:02:00<\/MediaDuration>/);

  await renderer.handleAction(AV_TRANSPORT_TYPE, 'Play', { Speed: '1' });
  assert.equal(calls.played.length, 1);
  assert.equal(calls.played[0].url, 'http://host/a.mp3');
  assert.equal(calls.played[0].title, 'Track');
  assert.equal(calls.videos.length, 0);

  const transport = await renderer.handleAction(AV_TRANSPORT_TYPE, 'GetTransportInfo', {});
  assert.match(transport, /<CurrentTransportState>PLAYING<\/CurrentTransportState>/);
});

test('video media is routed through the adapter video path', async () => {
  const { adapter, calls } = makeAdapter();
  const renderer = new DlnaRenderer(adapter);

  await renderer.handleAction(AV_TRANSPORT_TYPE, 'SetAVTransportURI', {
    CurrentURI: 'http://host/v.mp4',
    CurrentURIMetaData: VIDEO_DIDL,
  });
  await renderer.handleAction(AV_TRANSPORT_TYPE, 'Play', { Speed: '1' });

  assert.equal(calls.videos.length, 1);
  assert.equal(calls.videos[0], 'http://host/v.mp4');
  assert.equal(calls.played.length, 0);

  await renderer.handleAction(AV_TRANSPORT_TYPE, 'Stop', {});
  assert.equal(calls.videoStops, 1);
});

test('pause then play resumes audio instead of restarting', async () => {
  const { adapter, calls } = makeAdapter();
  const renderer = new DlnaRenderer(adapter);

  await renderer.handleAction(AV_TRANSPORT_TYPE, 'SetAVTransportURI', {
    CurrentURI: 'http://host/a.mp3',
    CurrentURIMetaData: AUDIO_DIDL,
  });
  await renderer.handleAction(AV_TRANSPORT_TYPE, 'Play', { Speed: '1' });
  await renderer.handleAction(AV_TRANSPORT_TYPE, 'Pause', {});
  assert.equal(calls.paused, 1);

  const paused = await renderer.handleAction(AV_TRANSPORT_TYPE, 'GetTransportInfo', {});
  assert.match(paused, /PAUSED_PLAYBACK/);

  await renderer.handleAction(AV_TRANSPORT_TYPE, 'Play', { Speed: '1' });
  assert.equal(calls.resumed, 1);
  assert.equal(calls.played.length, 1, 'resume must not re-spawn playback');
});

test('Play without media raises a UPnP transition error', async () => {
  const { adapter } = makeAdapter();
  const renderer = new DlnaRenderer(adapter);
  await assert.rejects(
    () => renderer.handleAction(AV_TRANSPORT_TYPE, 'Play', {}),
    (err: unknown) => err instanceof UpnpError && err.code === 701,
  );
});

test('Seek parses REL_TIME and forwards to the adapter', async () => {
  const { adapter, calls } = makeAdapter();
  const renderer = new DlnaRenderer(adapter);
  await renderer.handleAction(AV_TRANSPORT_TYPE, 'SetAVTransportURI', {
    CurrentURI: 'http://host/a.mp3',
    CurrentURIMetaData: AUDIO_DIDL,
  });
  await renderer.handleAction(AV_TRANSPORT_TYPE, 'Seek', { Unit: 'REL_TIME', Target: '0:00:30' });
  assert.deepEqual(calls.seeks, [30]);

  const position = await renderer.handleAction(AV_TRANSPORT_TYPE, 'GetPositionInfo', {});
  assert.match(position, /<RelTime>0:00:30<\/RelTime>/);

  await assert.rejects(
    () => renderer.handleAction(AV_TRANSPORT_TYPE, 'Seek', { Unit: 'TRACK_NR', Target: '2' }),
    (err: unknown) => err instanceof UpnpError && err.code === 710,
  );
});

test('RenderingControl volume and mute reach the adapter', async () => {
  const { adapter, calls } = makeAdapter();
  const renderer = new DlnaRenderer(adapter);

  const initial = await renderer.handleAction(RENDERING_CONTROL_TYPE, 'GetVolume', { Channel: 'Master' });
  assert.match(initial, /<CurrentVolume>50<\/CurrentVolume>/);

  await renderer.handleAction(RENDERING_CONTROL_TYPE, 'SetVolume', { Channel: 'Master', DesiredVolume: '80' });
  assert.deepEqual(calls.volumes, [80]);

  await renderer.handleAction(RENDERING_CONTROL_TYPE, 'SetMute', { Channel: 'Master', DesiredMute: '1' });
  assert.deepEqual(calls.mutes, [true]);

  const mute = await renderer.handleAction(RENDERING_CONTROL_TYPE, 'GetMute', { Channel: 'Master' });
  assert.match(mute, /<CurrentMute>1<\/CurrentMute>/);
});

test('ConnectionManager advertises audio and video sink protocols', async () => {
  const { adapter } = makeAdapter();
  const renderer = new DlnaRenderer(adapter);
  const info = await renderer.handleAction(CONNECTION_MANAGER_TYPE, 'GetProtocolInfo', {});
  assert.match(info, /audio\/mpeg/);
  assert.match(info, /video\/mp4/);
});

test('unknown actions raise Invalid Action', async () => {
  const { adapter } = makeAdapter();
  const renderer = new DlnaRenderer(adapter);
  await assert.rejects(
    () => renderer.handleAction(AV_TRANSPORT_TYPE, 'Bogus', {}),
    (err: unknown) => err instanceof UpnpError && err.code === 401,
  );
});

test('GENA subscribers receive a LastChange event on state change', async () => {
  const { adapter } = makeAdapter();
  const events: Array<{ sid: string; body: string }> = [];
  const renderer = new DlnaRenderer(adapter, (subscriber, body) => {
    events.push({ sid: subscriber.sid, body });
  });

  const subscriber = renderer.subscribe(AV_TRANSPORT_TYPE, 'http://192.168.1.5:1234/notify', 1800);
  renderer.sendInitialEvent(subscriber);
  assert.equal(events.length, 1);
  assert.match(events[0].body, /<LastChange>/);
  assert.match(events[0].body, /NO_MEDIA_PRESENT/);

  await renderer.handleAction(AV_TRANSPORT_TYPE, 'SetAVTransportURI', {
    CurrentURI: 'http://host/a.mp3',
    CurrentURIMetaData: AUDIO_DIDL,
  });
  assert.equal(events.length, 2);
  assert.match(events[1].body, /STOPPED/);

  assert.equal(renderer.unsubscribe(subscriber.sid), true);
  await renderer.handleAction(AV_TRANSPORT_TYPE, 'Play', { Speed: '1' });
  assert.equal(events.length, 2, 'unsubscribed listeners must not receive events');
});
