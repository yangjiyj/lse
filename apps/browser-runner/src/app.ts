import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { createInternalAuthHook } from './auth.js';
import type { RunnerConfig } from './contracts.js';
import { turnRequestSchema } from './contracts.js';
import type { DnsResolver } from './ip-guard.js';
import type { BrowserRunner, RouteTransport } from './browser.js';

export interface BuildRunnerAppOptions {
  config: RunnerConfig;
  resolver?: DnsResolver;
  runner?: BrowserRunner;
  routeTransport?: RouteTransport;
}

export async function buildRunnerApp(options: BuildRunnerAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: process.env.LSE_BROWSER_RUNNER_TEST === '1' ? false : { level: 'info' },
    bodyLimit: 1024 * 1024,
  });
  const runner = options.runner ?? (await createBrowserRunner(options));

  app.addHook('preHandler', createInternalAuthHook(options.config.internalToken));
  app.addHook('onClose', async () => {
    await runner.close();
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({ error: 'validation_error', issues: error.issues });
      return;
    }
    const statusCode =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    const message = error instanceof Error ? error.message : 'internal_error';
    reply.code(statusCode).send({ error: message });
  });

  app.get('/healthz', async () => ({
    status: 'ok',
    service: '@lse/browser-runner',
    time: new Date().toISOString(),
  }));

  app.post('/sessions/:sessionId/turn', async (request) => {
    const params = request.params as { sessionId: string };
    const body = turnRequestSchema.parse(request.body);
    return await runner.turn(params.sessionId, body);
  });

  app.delete('/sessions/:sessionId', async (request, reply) => {
    const params = request.params as { sessionId: string };
    await runner.closeSession(params.sessionId);
    reply.code(204).send();
  });

  return app;
}

async function createBrowserRunner(options: BuildRunnerAppOptions): Promise<BrowserRunner> {
  const module = await import('./browser.js');
  return new module.BrowserRunner(options.config, options.resolver, options.routeTransport);
}
