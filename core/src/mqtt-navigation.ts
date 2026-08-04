import mqtt, { type MqttClient } from 'mqtt';
import type { Pool } from 'pg';
import type { PageRow } from './legacy-routes.js';

export interface MqttNavigationStatus {
  enabled: boolean;
  connected: boolean;
  url: string;
  lastError: string | null;
  connectedAt: string | null;
}

type DeliverPage = (page: PageRow, deviceId: string) => Promise<unknown>;
type ControlMedia = (
  deviceId: string,
  action: 'pause' | 'resume' | 'stop' | 'next',
  source: string,
) => Promise<unknown>;

function parseJson(payload: Buffer): Record<string, unknown> {
  const parsed = JSON.parse(payload.toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('command payload must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export class MqttNavigationService {
  private client: MqttClient | null = null;
  private status: MqttNavigationStatus = {
    enabled: false,
    connected: false,
    url: '',
    lastError: null,
    connectedAt: null,
  };

  constructor(
    private readonly pool: Pool,
    private readonly deliverPage: DeliverPage,
    private readonly controlMedia?: ControlMedia,
  ) {}

  getStatus(): MqttNavigationStatus {
    return { ...this.status };
  }

  async start(): Promise<MqttNavigationStatus> {
    await this.stop();
    const settings = await this.pool.query(
      `SELECT key, value FROM settings
       WHERE key IN ('mqtt_enabled', 'mqtt_broker_url', 'mqtt_username', 'mqtt_password')`,
    );
    const values = Object.fromEntries(settings.rows.map(row => [String(row.key), String(row.value)]));
    const enabled = values.mqtt_enabled === '1';
    const url = values.mqtt_broker_url || 'mqtt://localhost:1883';
    this.status = { enabled, connected: false, url, lastError: null, connectedAt: null };
    if (!enabled) return this.getStatus();
    let protocol = '';
    try {
      protocol = new URL(url).protocol;
    } catch {
      this.status.lastError = 'Broker URL is invalid';
      return this.getStatus();
    }
    if (!['mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(protocol)) {
      this.status.lastError = 'Broker URL must use mqtt://, mqtts://, ws://, or wss://';
      return this.getStatus();
    }

    const client = mqtt.connect(url, {
      username: values.mqtt_username || undefined,
      password: values.mqtt_password || undefined,
      reconnectPeriod: 5_000,
      clean: true,
      connectTimeout: 10_000,
    });
    this.client = client;
    client.on('connect', () => {
      this.status.connected = true;
      this.status.lastError = null;
      this.status.connectedAt = new Date().toISOString();
      client.subscribe([
        'canvas/devices/+/commands/page',
        'canvas/devices/+/commands/panel',
        'canvas/devices/+/commands/media',
        'canvas/devices/+/panels/+/commands',
      ], error => {
        if (error) this.status.lastError = error.message;
      });
    });
    client.on('reconnect', () => { this.status.connected = false; });
    client.on('close', () => { this.status.connected = false; });
    client.on('offline', () => { this.status.connected = false; });
    client.on('error', error => {
      this.status.connected = false;
      this.status.lastError = error.message;
    });
    client.on('message', (topic, payload) => {
      void this.handleMessage(topic, payload);
    });
    return this.getStatus();
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) {
      await new Promise<void>(resolve => client.end(true, {}, () => resolve()));
    }
    this.status.connected = false;
    this.status.connectedAt = null;
  }

  private async pageWithPanels(pageId: string): Promise<PageRow | null> {
    const [page, panels] = await Promise.all([
      this.pool.query('SELECT * FROM pages WHERE id = $1', [pageId]),
      this.pool.query('SELECT * FROM page_panels WHERE page_id = $1 ORDER BY position, id', [pageId]),
    ]);
    if (page.rowCount === 0) return null;
    return { ...page.rows[0], panels: panels.rows } as PageRow;
  }

  private publish(topic: string, body: Record<string, unknown>, retain = false): void {
    this.client?.publish(topic, JSON.stringify(body), { retain });
  }

  private async handleMessage(topic: string, payload: Buffer): Promise<void> {
    const parts = topic.split('/');
    const deviceId = parts[2];
    if (!deviceId) return;
    const stateTopic = `canvas/devices/${deviceId}/state/navigation`;
    try {
      const body = parseJson(payload);
      if (parts[3] === 'commands' && parts[4] === 'media') {
        const action = typeof body.action === 'string' ? body.action : '';
        if (!['pause', 'resume', 'stop', 'next'].includes(action)) {
          throw new Error('media action must be pause, resume, stop, or next');
        }
        const source = typeof body.source === 'string' ? body.source : 'youtube';
        if (!this.controlMedia) throw new Error('media control is unavailable');
        const result = await this.controlMedia(
          deviceId,
          action as 'pause' | 'resume' | 'stop' | 'next',
          source,
        );
        this.publish(`canvas/devices/${deviceId}/state/media`, {
          ok: true,
          action,
          source,
          result,
        });
        return;
      }

      if (parts[3] === 'commands' && parts[4] === 'page') {
        const pageId = typeof body.page_id === 'string' ? body.page_id : '';
        if (!pageId) throw new Error('page_id is required');
        const page = await this.pageWithPanels(pageId);
        if (!page) throw new Error('page not found');
        await this.pool.query(
          `INSERT INTO device_page_library (device_id, page_id, sync_status, assigned_at)
           VALUES ($1, $2, 'pending', now())
           ON CONFLICT (device_id, page_id) DO NOTHING`,
          [deviceId, pageId],
        );
        await this.pool.query(
          `INSERT INTO device_page_state (device_id, active_page_id, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (device_id) DO UPDATE SET active_page_id = excluded.active_page_id, updated_at = now()`,
          [deviceId, pageId],
        );
        await this.deliverPage(page, deviceId);
        this.publish(stateTopic, { ok: true, active_page_id: pageId }, true);
        return;
      }

      if (
        (parts[3] === 'panels' && parts[5] === 'commands') ||
        (parts[3] === 'commands' && parts[4] === 'panel')
      ) {
        let panelId = parts[3] === 'panels'
          ? parts[4]
          : typeof body.panel_id === 'string' ? body.panel_id : '';
        if (!panelId && typeof body.panel === 'string') {
          const active = await this.pool.query(
            'SELECT active_page_id FROM device_page_state WHERE device_id = $1',
            [deviceId],
          );
          const activePageId = String(active.rows[0]?.active_page_id ?? '');
          if (!activePageId) throw new Error('device has no active page');
          const matches = await this.pool.query(
            'SELECT id FROM page_panels WHERE page_id = $1 AND LOWER(name) = LOWER($2)',
            [activePageId, body.panel],
          );
          panelId = String(matches.rows[0]?.id ?? '');
        }
        if (!panelId) throw new Error('panel_id or panel is required');
        const panel = await this.pool.query('SELECT 1 FROM page_panels WHERE id = $1', [panelId]);
        if (panel.rowCount === 0) throw new Error('panel not found');
        const contentType = body.content_type;
        if (contentType !== undefined && contentType !== 'url' && contentType !== 'scene') {
          throw new Error('content_type must be url or scene');
        }
        if (contentType === 'url' && (typeof body.url !== 'string' || !/^https?:\/\//i.test(body.url))) {
          throw new Error('URL content requires an http:// or https:// URL');
        }
        if (contentType === 'scene') {
          if (typeof body.scene_id !== 'string') throw new Error('scene_id is required');
          const scene = await this.pool.query(
            `SELECT 1 FROM scenes WHERE id = $1 AND status = 'published'`,
            [body.scene_id],
          );
          if (scene.rowCount === 0) throw new Error('published scene not found');
        }
        const content = contentType === 'url'
          ? { type: 'url', url: body.url }
          : contentType === 'scene'
            ? { type: 'scene', scene_id: body.scene_id }
            : null;
        const visible = typeof body.visible === 'boolean' ? body.visible : null;
        await this.pool.query(
          `INSERT INTO device_panel_state (device_id, panel_id, content, visible, updated_at)
           VALUES ($1, $2, $3::jsonb, COALESCE($4, true), now())
           ON CONFLICT (device_id, panel_id) DO UPDATE SET
             content = COALESCE(excluded.content, device_panel_state.content),
             visible = COALESCE(excluded.visible, device_panel_state.visible),
             updated_at = now()`,
          [deviceId, panelId, content ? JSON.stringify(content) : null, visible],
        );
        const active = await this.pool.query(
          'SELECT active_page_id FROM device_page_state WHERE device_id = $1',
          [deviceId],
        );
        const activePageId = String(active.rows[0]?.active_page_id ?? '');
        if (!activePageId) throw new Error('device has no active page');
        const page = await this.pageWithPanels(activePageId);
        if (!page) throw new Error('active page not found');
        await this.deliverPage(page, deviceId);
        this.publish(stateTopic, { ok: true, panel_id: panelId, content, visible }, true);
        return;
      }
      throw new Error('unsupported navigation topic');
    } catch (error) {
      this.publish(stateTopic, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
