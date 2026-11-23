import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { notFound } from '../../lib/errors.js';
import { fleetAgentEnabled } from '../fleet-admin/config.js';
import { endpointEvalEnabled } from './config.js';
import { findPlatformSink, recordPlatformSinkHit } from '../agent-evals/platform-sink.js';
import { platformAppEnabled } from '../eval-targets/platform-adapters/config.js';
import { configureSinkInput, receivedCanaries } from './sink-input.js';
import { JOB_LOG, parseBinding } from './service.js';

export async function endpointSinkRoutes(app: FastifyInstance): Promise<void> {
  configureSinkInput(app);
  app.get('/:runToken/:channel', async (request, reply) => {
    if (!platformAppEnabled()) throw notFound();
    const { runToken, channel } = z.object({ runToken: z.string(), channel: z.string() }).parse(request.params);
    const registration = await findPlatformSink(runToken);
    const page = registration?.pages[channel];
    if (!page || !Object.hasOwn(registration!.pages, channel)) throw notFound();
    await recordPlatformSinkHit(registration!.taskId, runToken, registration!.canary, {}, 'fetch', channel);
    reply.type(page.contentType).header('cache-control', 'no-store');
    for (const [key, value] of Object.entries(page.extraHeaders ?? {})) reply.header(key, encodeURIComponent(value));
    return reply.send(page.body);
  });
  app.route({
    method: ['GET', 'POST'],
    url: '/:runToken/exfil',
    bodyLimit: 64 * 1024,
    handler: async (request) => {
      const { runToken } = z.object({ runToken: z.string() }).parse(request.params);
      if (!/^[a-f0-9]{48}$/.test(runToken)) throw notFound();
      if (platformAppEnabled()) {
        const platform = await findPlatformSink(runToken);
        if (platform) {
          await recordPlatformSinkHit(platform.taskId, runToken, platform.canary,
            { query: request.query, body: request.body, headers: request.headers });
          return { ok: true };
        }
      }
      if (!endpointEvalEnabled() && !fleetAgentEnabled()) throw notFound();
      const bindingLog = await prisma.evalTaskLog.findFirst({
        where: {
          message: JOB_LOG,
          context: { path: ['runToken'], equals: runToken },
          task: {
            status: { in: ['PENDING', 'RUNNING'] },
            createdAt: { gt: new Date(Date.now() - 25 * 3600_000) },
          },
        },
      });
      if (!bindingLog) throw notFound();
      const binding = parseBinding(bindingLog.context);
      const canaries = receivedCanaries(binding.pack.scenarios.flatMap((s) => s.canaries), { query: request.query, body: request.body, headers: request.headers });
      if (canaries.length)
        await prisma.evalTaskLog.create({
          data: { taskId: bindingLog.taskId, message: '终端诱饵接收', context: { canaries } },
        });
      return { ok: true };
    },
  });
}
