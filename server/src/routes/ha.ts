/**
 * HA Proxy routes — forwards requests to HA supervisor API.
 * Only available when the add-on has homeassistant_api: true.
 *
 * Phase 4 migration (D-012): Core is the primary HA integration point.
 * Set `CANVAS_SIDECAR_HA_PROXY_ENABLED=false` to opt out of these routes
 * on the sidecar — Core's HomeAssistantClient becomes the sole HA proxy.
 * Default is `true` (legacy behavior preserved) for backward compatibility.
 */
import type { FastifyInstance } from 'fastify';

const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const HA_API = 'http://supervisor/core/api';

/**
 * Phase 4 coexistence gate: when false, the HA proxy routes are not registered.
 * Core's HomeAssistantClient (core/src/providers/ha.ts) replaces these routes.
 */
const haProxyEnabled =
  (process.env.CANVAS_SIDECAR_HA_PROXY_ENABLED ?? 'true').toLowerCase() !== 'false';

async function supervisorFetch(path: string) {
  if (!SUPERVISOR_TOKEN) throw new Error('SUPERVISOR_TOKEN not available');
  const res = await fetch(`${HA_API}${path}`, {
    headers: {
      Authorization: `Bearer ${SUPERVISOR_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`HA API ${path} → ${res.status}`);
  return res.json();
}

async function supervisorPost(path: string, body: unknown) {
  if (!SUPERVISOR_TOKEN) throw new Error('SUPERVISOR_TOKEN not available');
  const res = await fetch(`${HA_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPERVISOR_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HA API POST ${path} → ${res.status}`);
  // HA returns [] for service calls
  const ct = res.headers.get('content-type') ?? '';
  return ct.includes('application/json') ? res.json() : {};
}

export async function haRoutes(app: FastifyInstance) {
  if (!haProxyEnabled) {
    console.log('[ha] HA proxy disabled (CANVAS_SIDECAR_HA_PROXY_ENABLED=false) — routes not registered');
    return;
  }
  // GET /api/ingress-info — returns this add-on's ingress path from the supervisor
  // Used by the kiosk app to load panels via HA ingress so Lovelace cards can access HA frontend
  app.get('/ingress-info', async (_req, reply) => {
    if (!SUPERVISOR_TOKEN) {
      return reply.send({ ingress_url: null });
    }
    try {
      const res = await fetch('http://supervisor/addons/self/info', {
        headers: { Authorization: `Bearer ${SUPERVISOR_TOKEN}` },
      });
      if (!res.ok) return reply.send({ ingress_url: null });
      const info = await res.json() as any;
      return reply.send({ ingress_url: info?.data?.ingress_url ?? null });
    } catch {
      return reply.send({ ingress_url: null });
    }
  });

  // GET /api/ha/states — returns all entity states
  app.get('/ha/states', async (_req, reply) => {
    try {
      reply.send(await supervisorFetch('/states'));
    } catch (err: any) {
      reply.code(503).send({ error: err.message });
    }
  });

  // GET /api/ha/states/:entityId — single entity state
  app.get<{ Params: { entityId: string } }>('/ha/states/:entityId', async (req, reply) => {
    try {
      reply.send(await supervisorFetch(`/states/${req.params.entityId}`));
    } catch (err: any) {
      reply.code(503).send({ error: err.message });
    }
  });

  // GET /api/ha/camera_proxy/:entityId — proxy a camera snapshot from HA
  app.get<{ Params: { entityId: string } }>('/ha/camera_proxy/:entityId', async (req, reply) => {
    if (!SUPERVISOR_TOKEN) {
      reply.code(503).send({ error: 'SUPERVISOR_TOKEN not available' });
      return;
    }
    try {
      const res = await fetch(`${HA_API}/camera_proxy/${req.params.entityId}`, {
        headers: { Authorization: `Bearer ${SUPERVISOR_TOKEN}` },
      });
      if (!res.ok) {
        reply.code(res.status).send({ error: `HA camera_proxy → ${res.status}` });
        return;
      }
      reply.header('Content-Type', res.headers.get('content-type') ?? 'image/jpeg');
      reply.header('Cache-Control', 'no-cache, no-store');
      reply.send(Buffer.from(await res.arrayBuffer()));
    } catch (err: any) {
      reply.code(503).send({ error: err.message });
    }
  });

  // POST /api/ha/services/:domain/:service — call an HA service
  app.post<{ Params: { domain: string; service: string } }>(
    '/ha/services/:domain/:service',
    async (req, reply) => {
      try {
        const result = await supervisorPost(
          `/services/${req.params.domain}/${req.params.service}`,
          req.body ?? {},
        );
        reply.send(result);
      } catch (err: any) {
        reply.code(503).send({ error: err.message });
      }
    },
  );
}
