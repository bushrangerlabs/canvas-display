import { getDb } from '../db/index';

export function getEdgeDeviceId(): string {
  const read = (key: string) => (getDb().prepare('SELECT value FROM server_settings WHERE key=?').get(key) as { value?: string } | undefined)?.value ?? '';
  return read('edge_device_id') || process.env.CANVAS_EDGE_DEVICE_ID || read('device_id') || process.env.CANVAS_DEVICE_ID || 'unknown';
}
