/**
 * Log routes:
 *
 *   GET /api/logs/history  → recent log lines as JSON array
 *   GET /api/logs/stream   → SSE stream of new log lines (text/event-stream)
 */

import type { FastifyInstance } from 'fastify';
import { getLogHistory, logEmitter } from '../logs';

export async function logRoutes(app: FastifyInstance) {
  /** Recent history (up to 1000 lines) */
  app.get('/logs/history', async (_req, reply) => {
    return reply.send({ lines: getLogHistory() });
  });

  /** SSE live stream */
  app.get('/logs/stream', async (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering if behind proxy
    });

    // Send buffered history first so the client has context
    const history = getLogHistory();
    for (const line of history) {
      reply.raw.write(`data: ${JSON.stringify(line)}\n\n`);
    }

    // Send a heartbeat comment every 15 s to keep the connection alive
    const heartbeat = setInterval(() => {
      reply.raw.write(': heartbeat\n\n');
    }, 15_000);

    const onLine = (line: string) => {
      reply.raw.write(`data: ${JSON.stringify(line)}\n\n`);
    };

    logEmitter.on('line', onLine);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      logEmitter.off('line', onLine);
    });

    // Keep the handler promise alive until the client disconnects
    await new Promise<void>(resolve => req.raw.on('close', resolve));
  });
}
