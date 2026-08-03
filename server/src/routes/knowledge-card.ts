/**
 * Knowledge Card API
 *
 * Stores the latest knowledge card (title + body + optional source/image)
 * pushed by Canvas Core after an AI web-search or Wikipedia lookup.
 * The KnowledgeCardWidget polls GET /api/knowledge-card/latest every few
 * seconds to pick up new content.
 *
 * POST /api/knowledge-card     — Core pushes a new card (replaces current)
 * DELETE /api/knowledge-card   — Core/display clears the current card
 * GET /api/knowledge-card/latest — Widget polls for the current card
 */

import type { FastifyInstance } from 'fastify';

interface KnowledgeCard {
  title: string;
  body: string;
  source_url?: string;
  source_label?: string;
  image_url?: string;
  timestamp: string;
}

let currentCard: KnowledgeCard | null = null;

export async function knowledgeCardRoutes(fastify: FastifyInstance): Promise<void> {
  /** Widget polls this endpoint */
  fastify.get('/knowledge-card/latest', async (_req, reply) => {
    if (!currentCard) return reply.send({ empty: true });
    return reply.send(currentCard);
  });

  /** Core (or any authorized caller) pushes a new card */
  fastify.post<{ Body: Partial<KnowledgeCard> }>('/knowledge-card', async (req, reply) => {
    const { title, body, source_url, source_label, image_url } = req.body ?? {};
    if (!title || !body) {
      return reply.code(400).send({ error: 'title and body are required' });
    }
    currentCard = {
      title,
      body,
      source_url,
      source_label,
      image_url,
      timestamp: new Date().toISOString(),
    };
    return reply.send({ ok: true, timestamp: currentCard.timestamp });
  });

  /** Clear the current card */
  fastify.delete('/knowledge-card', async (_req, reply) => {
    currentCard = null;
    return reply.send({ ok: true });
  });
}
