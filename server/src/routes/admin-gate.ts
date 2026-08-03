/**
 * Phase 3 coexistence gate for sidecar admin/fleet routes.
 *
 * The legacy sidecar currently serves both the kiosk display (which only
 * needs to read pages/settings and receive commands) and the editor SPA
 * (which needs the full CRUD surface). As Canvas Core takes over fleet
 * management, the admin/fleet-only write endpoints on the sidecar become
 * redundant and should be disabled on pure display kiosks.
 *
 * Set `CANVAS_SIDECAR_ADMIN_ENABLED=false` to make the gated admin write
 * endpoints return 403. The default (`true`) preserves legacy behavior so
 * the currently-running sidecar is unaffected until an operator opts in.
 *
 * Read endpoints (GET) are intentionally NOT gated — the kiosk display and
 * editor both need to read pages, settings, and device state.
 */

const ADMIN_ENABLED =
  (process.env.CANVAS_SIDECAR_ADMIN_ENABLED ?? 'true').toLowerCase() !== 'false';

export function isAdminEnabled(): boolean {
  return ADMIN_ENABLED;
}

/**
 * Fastify preHandler-style guard for admin write endpoints. Returns `true`
 * when the request may proceed, `false` when the caller has already been
 * sent a 403 and the route handler should return early.
 */
export function guardAdmin(reply: import('fastify').FastifyReply): boolean {
  if (ADMIN_ENABLED) return true;
  reply.code(403).send({
    error: 'Admin endpoints disabled on this sidecar (CANVAS_SIDECAR_ADMIN_ENABLED=false)',
    statusCode: 403,
  });
  return false;
}
