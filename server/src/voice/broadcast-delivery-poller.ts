import { unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { getDb } from '../db/index';
import { playAudioToCompletion } from '../routes/audio';
import { ensureWav } from './audio-utils';

interface Delivery {
  empty?: boolean;
  deliveryId: string;
  kind: 'audio' | 'tts' | 'intercom' | 'alert';
  title?: string;
  payload?: Record<string, unknown>;
  audioBase64?: string;
  mimeType?: string;
}

let timer: NodeJS.Timeout | null = null;
let stopped = false;
let busy = false;

function bridgeConfig(): { baseUrl: string; token: string; deviceId: string } {
  const read = (key: string) => (getDb().prepare('SELECT value FROM server_settings WHERE key=?').get(key) as { value?: string } | undefined)?.value ?? '';
  return {
    baseUrl: (read('canvas_core_url') || process.env.CANVAS_CORE_URL || '').replace(/\/+$/, ''),
    token: read('edge_voice_token') || process.env.CANVAS_EDGE_VOICE_TOKEN || '',
    deviceId: read('edge_device_id') || read('device_id') || process.env.CANVAS_EDGE_DEVICE_ID || process.env.CANVAS_DEVICE_ID || '',
  };
}

function received(id: string): boolean {
  return Boolean(getDb().prepare('SELECT 1 FROM broadcast_delivery_receipts WHERE delivery_id=?').get(id));
}

function remember(id: string): void {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO broadcast_delivery_receipts(delivery_id) VALUES (?)').run(id);
  db.prepare("DELETE FROM broadcast_delivery_receipts WHERE completed_at < datetime('now','-7 days')").run();
}

async function ack(baseUrl: string, token: string, deviceId: string, deliveryId: string, state: 'started' | 'completed' | 'failed', error?: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/edge/deliveries/${encodeURIComponent(deliveryId)}/ack`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId, state, error }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok && response.status !== 404) throw new Error(`acknowledgement failed: HTTP ${response.status}`);
}

async function audioFor(delivery: Delivery): Promise<Buffer | null> {
  if (delivery.audioBase64) return Buffer.from(delivery.audioBase64, 'base64');
  const text = typeof delivery.payload?.text === 'string' ? delivery.payload.text.trim() : '';
  if (!text) return null;
  const piper = ((getDb().prepare('SELECT value FROM server_settings WHERE key=?').get('piper_url') as { value?: string } | undefined)?.value
    || process.env.PIPER_URL || 'http://127.0.0.1:10200/speak').replace(/\/$/, '');
  const response = await fetch(piper, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Piper synthesis failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function execute(delivery: Delivery, localPort: number, cfg: ReturnType<typeof bridgeConfig>): Promise<void> {
  if (received(delivery.deliveryId)) {
    await ack(cfg.baseUrl, cfg.token, cfg.deviceId, delivery.deliveryId, 'completed');
    return;
  }
  if (delivery.kind === 'alert') {
    await ack(cfg.baseUrl, cfg.token, cfg.deviceId, delivery.deliveryId, 'started');
    const payload = delivery.payload ?? {};
    const response = await fetch(`http://127.0.0.1:${localPort}/api/alert`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, title: delivery.title || payload.title || 'Alert', duration: payload.duration || 15 }),
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new Error(`local alert failed: HTTP ${response.status}`);
  } else {
    const raw = await audioFor(delivery);
    if (!raw?.length) throw new Error('delivery contains no playable audio');
    const sampleRate = Number.parseInt(process.env.CANVAS_CORE_TTS_SAMPLE_RATE ?? '22050', 10);
    const declaredWav = delivery.mimeType?.includes('wav');
    const isWav = raw.subarray(0, 4).toString('ascii') === 'RIFF';
    const audio = declaredWav && !isWav
      ? ensureWav(raw, Number.isFinite(sampleRate) ? sampleRate : 22_050)
      : raw;
    const file = path.join('/tmp', `canvas-delivery-${delivery.deliveryId}.wav`);
    writeFileSync(file, audio);
    try {
      await playAudioToCompletion(
        { url: file, title: delivery.title || 'Broadcast', volume: Number(process.env.CANVAS_TTS_VOLUME ?? 85) },
        () => ack(cfg.baseUrl, cfg.token, cfg.deviceId, delivery.deliveryId, 'started'),
      );
    } finally {
      try { unlinkSync(file); } catch { /* already removed */ }
    }
  }
  remember(delivery.deliveryId);
  await ack(cfg.baseUrl, cfg.token, cfg.deviceId, delivery.deliveryId, 'completed');
}

async function poll(localPort: number): Promise<void> {
  if (stopped || busy) return;
  const cfg = bridgeConfig();
  if (!cfg.baseUrl || !cfg.token || !cfg.deviceId) return;
  busy = true;
  let delivery: Delivery | null = null;
  try {
    const response = await fetch(`${cfg.baseUrl}/api/edge/deliveries/next?deviceId=${encodeURIComponent(cfg.deviceId)}`, {
      headers: { authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return;
    delivery = await response.json() as Delivery;
    if (delivery.empty || !delivery.deliveryId) return;
    await execute(delivery, localPort, cfg);
  } catch (error) {
    if (delivery?.deliveryId) {
      await ack(cfg.baseUrl, cfg.token, cfg.deviceId, delivery.deliveryId, 'failed', error instanceof Error ? error.message : String(error)).catch(() => undefined);
    }
    console.warn('[broadcast-delivery] delivery failed:', error instanceof Error ? error.message : error);
  } finally {
    busy = false;
  }
}

export function startBroadcastDeliveryPoller(localPort: number): void {
  if (timer) return;
  stopped = false;
  const interval = Math.max(1_000, Number(process.env.BROADCAST_DELIVERY_POLL_MS ?? 2_000));
  timer = setInterval(() => void poll(localPort), interval);
  void poll(localPort);
  console.log('[broadcast-delivery] durable poller started');
}

export function stopBroadcastDeliveryPoller(): void {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
}
