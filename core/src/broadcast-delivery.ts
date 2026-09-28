import { randomUUID } from 'node:crypto';
import dgram from 'node:dgram';
import type pg from 'pg';

export type BroadcastRouteType = 'edge' | 'ha' | 'dlna';
export type BroadcastKind = 'audio' | 'tts' | 'intercom' | 'alert';
export type DeliveryState = 'pending' | 'claimed' | 'started' | 'completed' | 'failed' | 'expired';

export interface BroadcastOutput {
  id: string;
  logical_id: string;
  route_type: BroadcastRouteType;
  route_key: string;
  name: string;
  selected: boolean;
  preferred: boolean;
  online: boolean;
  metadata: Record<string, unknown>;
  last_seen: string | Date;
}

export interface BroadcastPayload {
  kind: BroadcastKind;
  title?: string;
  payload?: Record<string, unknown>;
  audio?: Buffer;
  mimeType?: string;
  targetOutputIds?: string[];
  expiresInMs?: number;
}

export interface ClaimedDelivery {
  deliveryId: string;
  eventId: string;
  kind: BroadcastKind;
  title: string;
  payload: Record<string, unknown>;
  audioBase64?: string;
  mimeType?: string;
  expiresAt: string | Date;
  attempts: number;
}

const DEFAULT_EXPIRY_MS = 10 * 60_000;
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const AUDIO_MIME_TYPES = new Set([
  'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/ogg',
  'audio/opus', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/flac',
]);

export class BroadcastDeliveryService {
  constructor(private readonly pool: pg.Pool) {}

  async upsertOutput(input: {
    id: string;
    logicalId?: string;
    routeType: BroadcastRouteType;
    routeKey: string;
    name: string;
    online?: boolean;
    metadata?: Record<string, unknown>;
    selectOnCreate?: boolean;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO broadcast_outputs
         (id, logical_id, route_type, route_key, name, selected, online, metadata, last_seen, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,now(),now())
       ON CONFLICT (id) DO UPDATE SET
         name=excluded.name, online=excluded.online, metadata=excluded.metadata,
         last_seen=now(), updated_at=now()`,
      [
        input.id,
        input.logicalId ?? input.id,
        input.routeType,
        input.routeKey,
        input.name,
        input.selectOnCreate ?? false,
        input.online ?? true,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }

  async markRoutesOffline(routeTypes: BroadcastRouteType[]): Promise<void> {
    if (routeTypes.length === 0) return;
    await this.pool.query(
      `UPDATE broadcast_outputs SET online=false, updated_at=now() WHERE route_type = ANY($1::text[])`,
      [routeTypes],
    );
  }

  async listOutputs(): Promise<BroadcastOutput[]> {
    const result = await this.pool.query(
      `SELECT id, logical_id, route_type, route_key, name, selected, preferred,
              online, metadata, last_seen
       FROM broadcast_outputs ORDER BY name, route_type, id`,
    );
    return result.rows as BroadcastOutput[];
  }

  /** Look up a single output by its id (used by destination-targeted playback). */
  async getOutput(id: string): Promise<BroadcastOutput | null> {
    const result = await this.pool.query(
      `SELECT id, logical_id, route_type, route_key, name, selected, preferred,
              online, metadata, last_seen
       FROM broadcast_outputs WHERE id = $1`,
      [id],
    );
    return (result.rows[0] as BroadcastOutput | undefined) ?? null;
  }

  async updateOutput(id: string, patch: {
    selected?: boolean;
    preferred?: boolean;
    logicalId?: string;
  }): Promise<BroadcastOutput | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT * FROM broadcast_outputs WHERE id=$1', [id]);
      if (current.rowCount === 0) {
        await client.query('ROLLBACK');
        return null;
      }
      const row = current.rows[0];
      const logicalId = patch.logicalId?.trim() || row.logical_id;
      if (patch.selected !== undefined) {
        await client.query(
          `UPDATE broadcast_outputs SET selected=$2,updated_at=now() WHERE logical_id=$1`,
          [row.logical_id, patch.selected],
        );
      }
      const result = await client.query(
        `UPDATE broadcast_outputs SET selected=$2, preferred=$3, logical_id=$4, updated_at=now()
         WHERE id=$1 RETURNING id, logical_id, route_type, route_key, name, selected,
                                preferred, online, metadata, last_seen`,
        [id, patch.selected ?? row.selected, patch.preferred ?? row.preferred, logicalId],
      );
      if (patch.preferred === true) {
        await client.query(
          `UPDATE broadcast_outputs SET preferred=(id=$2),updated_at=now() WHERE logical_id=$1`,
          [logicalId, id],
        );
      }
      await client.query('COMMIT');
      return result.rows[0] as BroadcastOutput;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async enqueue(input: BroadcastPayload): Promise<{ eventId: string; deliveries: number; outputs: BroadcastOutput[] }> {
    if (input.audio) {
      if (input.audio.length === 0 || input.audio.length > MAX_AUDIO_BYTES) {
        throw new Error(`broadcast audio must be between 1 and ${MAX_AUDIO_BYTES} bytes`);
      }
      const mime = (input.mimeType ?? 'audio/wav').toLowerCase().split(';')[0].trim();
      if (!AUDIO_MIME_TYPES.has(mime)) throw new Error(`unsupported broadcast audio type: ${mime}`);
    }
    const eventId = randomUUID();
    const expiresInMs = Math.max(1_000, Math.min(24 * 60 * 60_000, input.expiresInMs ?? DEFAULT_EXPIRY_MS));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const outputResult = input.targetOutputIds?.length
        ? await client.query(
            `SELECT * FROM broadcast_outputs WHERE id = ANY($1::text[]) AND preferred=true`,
            [input.targetOutputIds],
          )
        : await client.query(
            `SELECT * FROM broadcast_outputs WHERE selected=true AND preferred=true`,
          );
      const outputs = outputResult.rows as BroadcastOutput[];
      await client.query(
        `INSERT INTO broadcast_events(id, kind, title, payload, audio, mime_type, expires_at)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,now() + ($7 * interval '1 millisecond'))`,
        [eventId, input.kind, input.title ?? '', JSON.stringify(input.payload ?? {}), input.audio ?? null, input.mimeType ?? null, expiresInMs],
      );
      for (const output of outputs) {
        await client.query(
          `INSERT INTO broadcast_deliveries(id,event_id,output_id) VALUES ($1,$2,$3)`,
          [randomUUID(), eventId, output.id],
        );
      }
      await client.query('COMMIT');
      return { eventId, deliveries: outputs.length, outputs };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async claimEdge(deviceId: string, kinds?: BroadcastKind[]): Promise<ClaimedDelivery | null> {
    const outputId = `edge:${deviceId}`;
    await this.expire();
    const kindFilter = kinds?.length ? kinds : ['audio', 'tts', 'intercom', 'alert'];
    const result = await this.pool.query(
      `UPDATE broadcast_deliveries d SET
         state='claimed', attempts=d.attempts+1,
         lease_until=now() + interval '30 seconds', updated_at=now()
       FROM broadcast_events e
       WHERE d.id = (
         SELECT candidate.id FROM broadcast_deliveries candidate
         JOIN broadcast_events event ON event.id=candidate.event_id
         WHERE candidate.output_id=$1
           AND event.kind = ANY($2::text[])
           AND event.expires_at > now()
           AND (candidate.state='pending' OR candidate.state='failed'
                OR (candidate.state IN ('claimed','started') AND candidate.lease_until < now()))
         ORDER BY event.created_at, candidate.updated_at LIMIT 1
       ) AND e.id=d.event_id
       RETURNING d.id AS delivery_id, d.attempts, e.id AS event_id, e.kind,
                 e.title, e.payload, e.audio, e.mime_type, e.expires_at`,
      [outputId, kindFilter],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      deliveryId: row.delivery_id,
      eventId: row.event_id,
      kind: row.kind,
      title: row.title,
      payload: row.payload ?? {},
      audioBase64: row.audio ? Buffer.from(row.audio).toString('base64') : undefined,
      mimeType: row.mime_type ?? undefined,
      expiresAt: row.expires_at,
      attempts: Number(row.attempts),
    };
  }

  async acknowledge(deliveryId: string, deviceId: string, state: 'started' | 'completed' | 'failed', error?: string): Promise<boolean> {
    const outputId = `edge:${deviceId}`;
    const result = await this.pool.query(
      `UPDATE broadcast_deliveries SET
         state=$3,
         started_at=CASE WHEN $3 IN ('started','completed') THEN COALESCE(started_at,now()) ELSE started_at END,
         completed_at=CASE WHEN $3='completed' THEN now() ELSE completed_at END,
         lease_until=CASE WHEN $3='started' THEN now() + interval '10 minutes' ELSE NULL END,
         last_error=$4, updated_at=now()
       WHERE id=$1 AND output_id=$2 AND state NOT IN ('completed','expired')`,
      [deliveryId, outputId, state, error?.slice(0, 500) ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async completeExternal(deliveryId: string, ok: boolean, error?: string): Promise<void> {
    await this.pool.query(
      `UPDATE broadcast_deliveries SET state=$2,
         started_at=CASE WHEN $2='completed' THEN COALESCE(started_at,now()) ELSE started_at END,
         completed_at=CASE WHEN $2='completed' THEN now() ELSE NULL END,
         last_error=$3, lease_until=NULL, updated_at=now() WHERE id=$1`,
      [deliveryId, ok ? 'completed' : 'failed', error?.slice(0, 500) ?? null],
    );
  }

  async pendingExternal(eventId: string): Promise<Array<{ deliveryId: string; output: BroadcastOutput }>> {
    const result = await this.pool.query(
      `SELECT d.id AS delivery_id, o.* FROM broadcast_deliveries d
       JOIN broadcast_outputs o ON o.id=d.output_id
       WHERE d.event_id=$1 AND o.route_type IN ('ha','dlna') AND d.state IN ('pending','failed')`,
      [eventId],
    );
    return result.rows.map(row => ({ deliveryId: row.delivery_id, output: row as BroadcastOutput }));
  }

  async listEvents(limit = 50): Promise<unknown[]> {
    const result = await this.pool.query(
      `SELECT e.id,e.kind,e.title,e.created_at,e.expires_at,
              COUNT(d.id)::int AS deliveries,
              COUNT(d.id) FILTER (WHERE d.state='completed')::int AS completed,
              COUNT(d.id) FILTER (WHERE d.state='failed')::int AS failed,
              COUNT(d.id) FILTER (WHERE d.state IN ('pending','claimed','started'))::int AS pending
       FROM broadcast_events e LEFT JOIN broadcast_deliveries d ON d.event_id=e.id
       GROUP BY e.id ORDER BY e.created_at DESC LIMIT $1`,
      [Math.max(1, Math.min(200, limit))],
    );
    return result.rows;
  }

  async getEventAudio(eventId: string): Promise<{ audio: Buffer; mimeType: string } | null> {
    const result = await this.pool.query(
      `SELECT audio,mime_type FROM broadcast_events WHERE id=$1 AND expires_at > now()`,
      [eventId],
    );
    const row = result.rows[0];
    if (!row?.audio) return null;
    return { audio: Buffer.from(row.audio), mimeType: row.mime_type || 'audio/wav' };
  }

  async expire(): Promise<void> {
    await this.pool.query(
      `UPDATE broadcast_deliveries d SET state='expired', lease_until=NULL, updated_at=now()
       FROM broadcast_events e WHERE e.id=d.event_id AND e.expires_at <= now()
         AND d.state NOT IN ('completed','expired')`,
    );
  }
}

export interface DiscoveredDlnaRenderer {
  usn: string;
  location: string;
  server?: string;
}

/** Bounded SSDP search used only by an explicit administrator refresh. */
export async function discoverDlnaRenderers(timeoutMs = 1_500): Promise<DiscoveredDlnaRenderer[]> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const found = new Map<string, DiscoveredDlnaRenderer>();
    const finish = () => {
      try { socket.close(); } catch { /* already closed */ }
      resolve([...found.values()]);
    };
    const timer = setTimeout(finish, Math.max(250, Math.min(5_000, timeoutMs)));
    socket.on('message', message => {
      const text = message.toString('utf8');
      const headers = Object.fromEntries(text.split(/\r?\n/).slice(1).flatMap(line => {
        const at = line.indexOf(':');
        return at > 0 ? [[line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()]] : [];
      }));
      const location = headers.location;
      const usn = headers.usn;
      if (location && usn && /MediaRenderer/i.test(text)) found.set(usn, { usn, location, server: headers.server });
    });
    socket.on('error', () => { clearTimeout(timer); finish(); });
    socket.bind(0, () => {
      const request = Buffer.from([
        'M-SEARCH * HTTP/1.1',
        'HOST: 239.255.255.250:1900',
        'MAN: "ssdp:discover"',
        'MX: 1',
        'ST: urn:schemas-upnp-org:device:MediaRenderer:1',
        '', '',
      ].join('\r\n'));
      socket.send(request, 1900, '239.255.255.250');
    });
  });
}
