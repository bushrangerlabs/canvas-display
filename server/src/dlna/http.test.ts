import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { startDlna, stopDlna, type DlnaHandle } from './index';
import type { DlnaPlaybackAdapter } from './renderer';

/**
 * End-to-end exercise of the DLNA HTTP control surface: device/service
 * descriptions, SOAP control dispatch and the health/state endpoint. SSDP is
 * disabled so the test never touches the multicast socket.
 */

const played: string[] = [];
let volume = 40;

const adapter: DlnaPlaybackAdapter = {
  playAudio: async (input) => { played.push(input.url); },
  pauseAudio: async () => {},
  resumeAudio: async () => {},
  stopAudio: async () => {},
  seekAudio: async () => {},
  setVolume: async (level) => { volume = level; },
  setMute: async () => {},
  getVolume: () => volume,
  getMuted: () => false,
  playVideo: () => {},
  stopVideo: () => {},
};

let handle: DlnaHandle;

before(async () => {
  const started = await startDlna({
    enabled: true,
    port: 0,
    uuid: 'test-uuid-0001',
    friendlyName: 'Canvas Display (test)',
    manufacturer: 'Canvas Display',
    modelName: 'Canvas Display',
    modelNumber: '0.3.1',
    host: '127.0.0.1',
    ssdp: false,
    adapter,
  });
  assert.ok(started, 'DLNA server should start');
  handle = started!;
});

after(() => stopDlna());

function soapEnvelope(serviceType: string, action: string, args: Record<string, string>): string {
  const inner = Object.entries(args)
    .map(([key, value]) => `<${key}>${value}</${key}>`)
    .join('');
  return (
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">' +
    `<s:Body><u:${action} xmlns:u="${serviceType}">${inner}</u:${action}></s:Body>` +
    '</s:Envelope>'
  );
}

async function control(serviceType: string, action: string, args: Record<string, string>): Promise<string> {
  const res = await fetch(`${handle.baseUrl}/control/${serviceType.split(':')[3]}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPACTION: `"${serviceType}#${action}"`,
    },
    body: soapEnvelope(serviceType, action, args),
  });
  assert.equal(res.status, 200, `${action} should return 200`);
  return res.text();
}

test('serves the device description with all MediaRenderer services', async () => {
  const res = await fetch(`${handle.baseUrl}/description.xml`);
  assert.equal(res.status, 200);
  const xml = await res.text();
  assert.match(xml, /MediaRenderer:1/);
  assert.match(xml, /uuid:test-uuid-0001/);
  assert.match(xml, /AVTransport/);
});

test('serves each service SCPD', async () => {
  for (const name of ['AVTransport', 'RenderingControl', 'ConnectionManager']) {
    const res = await fetch(`${handle.baseUrl}/service/${name}.xml`);
    assert.equal(res.status, 200, `${name} SCPD`);
    assert.match(await res.text(), /<scpd/);
  }
});

test('SOAP control drives playback end-to-end', async () => {
  const avt = 'urn:schemas-upnp-org:service:AVTransport:1';

  await control(avt, 'SetAVTransportURI', {
    InstanceID: '0',
    CurrentURI: 'http://host/a.mp3',
    CurrentURIMetaData: '&lt;DIDL-Lite&gt;&lt;item&gt;&lt;dc:title&gt;Track&lt;/dc:title&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;',
  });
  await control(avt, 'Play', { InstanceID: '0', Speed: '1' });
  assert.deepEqual(played, ['http://host/a.mp3']);

  const health = await (await fetch(`${handle.baseUrl}/health`)).json();
  assert.equal(health.transportState, 'PLAYING');
  assert.equal(health.title, 'Track');

  const rcs = 'urn:schemas-upnp-org:service:RenderingControl:1';
  const volumeResponse = await control(rcs, 'SetVolume', { InstanceID: '0', Channel: 'Master', DesiredVolume: '90' });
  assert.match(volumeResponse, /SetVolumeResponse/);
  assert.equal(volume, 90);
});

test('unknown control path returns 404 and bad SOAP action returns a fault', async () => {
  const missing = await fetch(`${handle.baseUrl}/control/Nope`, { method: 'POST', body: '' });
  assert.equal(missing.status, 404);

  const fault = await fetch(`${handle.baseUrl}/control/AVTransport`, {
    method: 'POST',
    headers: { SOAPACTION: '"urn:schemas-upnp-org:service:AVTransport:1#Bogus"' },
    body: soapEnvelope('urn:schemas-upnp-org:service:AVTransport:1', 'Bogus', {}),
  });
  assert.equal(fault.status, 500);
  assert.match(await fault.text(), /UPnPError/);
});