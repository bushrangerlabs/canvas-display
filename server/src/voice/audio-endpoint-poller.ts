import { getDb } from '../db/index';
import { restartVoiceServer } from './index';
import { getCoreBridgeConfig, getDirectWakewordState, startDirectWakeword, stopDirectWakeword } from './direct-wakeword';
import { getEdgeDeviceId } from './edge-identity';

let timer: NodeJS.Timeout | null = null;
let controller: AbortController | null = null;
let generation = 0;
let busy = false;
let retryDirect = false;

export interface EdgeAudioControls { playback_volume: number; treble_db: number; mic_capture_gain: number; mic_preemphasis: number }
const DEFAULT_CONTROLS: EdgeAudioControls = { playback_volume: 15, treble_db: 6, mic_capture_gain: 1, mic_preemphasis: 0.95 };
export interface Assignment { empty?: boolean; id?: string; address?: string; port?: number; token?: string; settings?: EdgeAudioControls }
function parseControls(value: unknown): EdgeAudioControls {
  if (value === undefined) return DEFAULT_CONTROLS;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid audio controls');
  const v = value as Record<string, unknown>;
  const bounds: Record<keyof EdgeAudioControls, [number, number]> = {
    playback_volume: [0, 100], treble_db: [-6, 9], mic_capture_gain: [0.5, 8], mic_preemphasis: [0, 0.99],
  };
  const result = {} as EdgeAudioControls;
  for (const key of Object.keys(bounds) as Array<keyof EdgeAudioControls>) {
    if (typeof v[key] !== 'number' || !Number.isFinite(v[key]) || v[key] < bounds[key][0] || v[key] > bounds[key][1]) throw new Error(`Invalid audio control ${key}`);
    result[key] = v[key] as number;
  }
  return result;
}
export function validateAssignment(value: unknown): Assignment {
  if (!value || typeof value !== 'object') throw new Error('Invalid audio assignment');
  const a = value as Assignment;
  if (a.empty === true) return { empty: true };
  if (typeof a.address !== 'string' || !a.address.trim() || typeof a.token !== 'string' || !a.token || Buffer.byteLength(a.token) > 255
    || (a.id !== undefined && typeof a.id !== 'string')
    || (a.port !== undefined && (!Number.isInteger(a.port) || a.port < 1 || a.port > 65535))) throw new Error('Invalid audio assignment fields');
  return { address: a.address.trim(), port: a.port ?? 8090, token: a.token, id: a.id ?? '', settings: parseControls(a.settings) };
}

async function poll(epoch: number): Promise<void> {
  if (!timer || epoch !== generation || busy) return;
  const db = getDb();
  const read = (key: string) => (db.prepare('SELECT value FROM server_settings WHERE key=?').get(key) as { value?: string } | undefined)?.value ?? '';
  const { baseUrl, token } = getCoreBridgeConfig();
  const deviceId = getEdgeDeviceId();
  if (!baseUrl || !token || deviceId === 'unknown') return;
  busy = true;
  const abort = new AbortController();
  controller = abort;
  try {
    const response = await fetch(`${baseUrl}/api/edge/audio/assignment?deviceId=${encodeURIComponent(deviceId)}`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]),
    });
    if (!response.ok) throw new Error(`Assignment HTTP ${response.status}`);
    const assignment = validateAssignment(await response.json());
    if (epoch !== generation || abort.signal.aborted) return;
    const values: Record<string, string> = {
      audio_endpoint_host: assignment.empty ? '' : assignment.address!,
      audio_endpoint_port: assignment.empty ? '' : String(assignment.port),
      audio_endpoint_token: assignment.empty ? '' : assignment.token!,
      audio_endpoint_id: assignment.empty ? '' : assignment.id!,
      audio_endpoint_controls: assignment.empty ? JSON.stringify(DEFAULT_CONTROLS) : JSON.stringify(assignment.settings),
    };
    const changed = Object.entries(values).some(([key, value]) => read(key) !== value);
    if (!changed) return;
    const previous = Object.fromEntries(Object.keys(values).map(key => [key, read(key)]));
    const write = (settings: Record<string, string>) => db.transaction(() => {
      const statement = db.prepare("INSERT INTO server_settings (key,value,updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at");
      for (const [key, value] of Object.entries(settings)) statement.run(key, value);
    })();
    write(values);
    console.log(`[audio-endpoint] assignment ${assignment.empty ? 'cleared' : `host=${assignment.address} port=${assignment.port}`} (credentials redacted)`);
    try {
      const direct = getDirectWakewordState();
      if (retryDirect || (direct.enabled && !['stopped', 'disabled'].includes(direct.status))) {
        retryDirect = true;
        await stopDirectWakeword();
        if (epoch !== generation || abort.signal.aborted) return;
        await startDirectWakeword();
        retryDirect = false;
      } else if (epoch === generation && !abort.signal.aborted) await restartVoiceServer();
    } catch (error) {
      write(previous); // A subsequent poll retries the assignment, including runtime application.
      throw error;
    }
  } catch (error) {
    if (!abort.signal.aborted) console.warn('[audio-endpoint] poll failed:', error instanceof Error ? error.message : 'unknown error');
  } finally {
    if (controller === abort) controller = null;
    busy = false;
  }
}
export function startAudioEndpointPoller(): void {
  if (timer) return;
  const epoch = ++generation;
  const configured = Number(process.env.AUDIO_ENDPOINT_POLL_MS ?? 10000);
  timer = setInterval(() => void poll(epoch), Number.isFinite(configured) ? Math.max(5000, configured) : 10000);
  void poll(epoch);
}
export function stopAudioEndpointPoller(): void {
  generation++;
  if (timer) clearInterval(timer);
  timer = null;
  controller?.abort();
}
