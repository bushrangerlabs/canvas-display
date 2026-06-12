/**
 * Local app configuration — persisted via Tauri's plugin-store (JSON file in app data dir).
 * Set on first boot, editable via hidden settings gesture.
 */
import { Store } from '@tauri-apps/plugin-store';

export interface AppConfig {
  /** Canvas UI server base URL e.g. http://192.168.1.10:3100 */
  serverUrl: string;
  /** Home Assistant base URL e.g. http://192.168.1.10:8123 */
  haUrl: string;
  /** HA long-lived access token */
  haToken: string;
  /** Display name for this device */
  deviceName: string;
  /** Persistent device ID (assigned on first registration, never changes) */
  deviceId?: string;
  /** Enable swipe gesture navigation between views */
  swipeNavEnabled: boolean;
  /** Platform identifier */
  platform: 'android';
}

let _store: Store | null = null;

async function getStore(): Promise<Store> {
  if (!_store) {
    _store = await Store.load('config.json', { autoSave: true, defaults: {} });
  }
  return _store;
}

export async function loadConfig(): Promise<AppConfig | null> {
  const store = await getStore();
  const serverUrl = await store.get<string>('serverUrl');
  if (!serverUrl) return null;
  return {
    serverUrl: serverUrl ?? '',
    haUrl: (await store.get<string>('haUrl')) ?? '',
    haToken: (await store.get<string>('haToken')) ?? '',
    deviceName: (await store.get<string>('deviceName')) ?? 'Canvas Display Android',
    deviceId: (await store.get<string>('deviceId')) ?? undefined,
    swipeNavEnabled: (await store.get<boolean>('swipeNavEnabled')) ?? true,
    platform: 'android',
  };
}

export async function saveConfig(config: AppConfig): Promise<void> {
  const store = await getStore();
  await store.set('serverUrl', config.serverUrl);
  await store.set('haUrl', config.haUrl);
  await store.set('haToken', config.haToken);
  await store.set('deviceName', config.deviceName);
  await store.set('swipeNavEnabled', config.swipeNavEnabled);
  if (config.deviceId) {
    await store.set('deviceId', config.deviceId);
  }
  await store.save();
}

export async function saveDeviceId(id: string): Promise<void> {
  const store = await getStore();
  await store.set('deviceId', id);
  await store.save();
}

export async function clearConfig(): Promise<void> {
  const store = await getStore();
  await store.clear();
  await store.save();
}
