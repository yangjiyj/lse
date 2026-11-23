import type { FastifyInstance } from 'fastify';
import { loadSecurityPolicy } from '../../lib/security-policy.js';
import { enforcePublicRateLimit } from '../../lib/public-rate-limit.js';
import { loadLoginCounts, recordVisit } from '../../lib/platform-stats.js';

/**
 * 登录页用的免登录接口。只返回平台级的开关和计数，不含任何租户数据；同一 IP 每分钟最多 30 次。
 */
export async function publicRoutes(app: FastifyInstance): Promise<void> {
  app.get('/login-stats', async (request, reply) => {
    await enforcePublicRateLimit('login-stats', request.ip);
    const [policy, counts] = await Promise.all([loadSecurityPolicy(), loadLoginCounts()]);
    reply.header('Cache-Control', 'no-store');
    return {
      ...counts,
      registrationEnabled: policy.registrationEnabled,
      // 注册页提示密码规则用；只给规则字段，关着注册时不给。
      passwordPolicy: policy.registrationEnabled
        ? {
            passwordMinLength: policy.passwordMinLength,
            passwordRequireUppercase: policy.passwordRequireUppercase,
            passwordRequireLowercase: policy.passwordRequireLowercase,
            passwordRequireDigit: policy.passwordRequireDigit,
            passwordRequireSpecial: policy.passwordRequireSpecial,
          }
        : null,
    };
  });

  // 登录页打开时调一次；同一 IP 30 分钟内只计一次。
  app.post('/visits', async (request, reply) => {
    await enforcePublicRateLimit('visits', request.ip);
    await recordVisit(request.ip);
    return reply.code(204).send();
  });
}
