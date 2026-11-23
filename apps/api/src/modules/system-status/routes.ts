import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { prisma } from '../../db.js';
import { forbidden, unauthorized } from '../../lib/errors.js';
import { getRedisConnection } from '../../lib/queue.js';
import { authenticate } from '../../plugins/auth.js';
import { DEPENDENCY_TIMEOUT_MS, collectSystemStatus, pingRedisWhenReady } from './collect.js';

const requirePlatformAdmin: preHandlerHookHandler = async (request) => {
  const user = request.currentUser;
  if (!user) throw unauthorized();
  if (!user.isPlatformAdmin) {
    throw forbidden('仅平台管理员可查看运行状态', 'PLATFORM_ADMIN_REQUIRED');
  }
};

/** 平台运行状态：CPU、内存（容器有上限时按上限）、磁盘、平台进程运行时长，以及数据库和 Redis 是否可用。 */
export async function systemStatusRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/status', { preHandler: [requirePlatformAdmin] }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return collectSystemStatus({
      checkDatabase: () => prisma.$queryRaw`SELECT 1`,
      checkRedis: () => pingRedisWhenReady(getRedisConnection(), DEPENDENCY_TIMEOUT_MS),
    });
  });
}
