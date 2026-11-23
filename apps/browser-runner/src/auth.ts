import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export function createInternalAuthHook(expectedToken: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (request.url === '/healthz') return;
    const header = request.headers['x-internal-token'];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!tokenMatches(provided, expectedToken)) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  };
}
