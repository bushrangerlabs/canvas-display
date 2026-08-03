import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { appendLog, getLogHistory, logEmitter } from './logger.js';

type RequireAdmin = (opts?: {
  roles?: ('admin' | 'viewer')[];
  csrf?: boolean;
}) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export async function registerLogRoutes(
  fastify: FastifyInstance,
  requireAdmin: RequireAdmin,
): Promise<void> {
  fastify.addHook('onResponse', async (request, reply) => {
    if (request.url.startsWith('/api/admin/logs/')) return;
    const path = request.url.split('?')[0];
    const routinePoll = request.method === 'GET' && (
      path === '/health'
      || path === '/api/admin/session'
      || path === '/api/ha/entities'
      || path.startsWith('/assets/')
      || path === '/favicon.svg'
    );
    const elapsed = Math.round(reply.elapsedTime);
    // Keep successful polling/static traffic out of the useful application log. Slow
    // requests and all errors remain visible.
    if (routinePoll && reply.statusCode < 400 && elapsed < 1_000) return;
    appendLog(reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warn' : 'info', [
      'http',
      request.method,
      request.url,
      reply.statusCode,
      `${elapsed}ms`,
    ]);
  });

  fastify.get('/api/admin/logs/history', {
    preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }),
  }, async () => ({ lines: getLogHistory() }));

  fastify.get('/api/admin/logs/stream', {
    preHandler: requireAdmin({ roles: ['admin', 'viewer'], csrf: false }),
  }, async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');

    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n');
    }, 15_000);
    heartbeat.unref();

    const onLine = (line: string) => {
      if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(line)}\n\n`);
    };
    logEmitter.on('line', onLine);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      logEmitter.off('line', onLine);
    });
  });
}
