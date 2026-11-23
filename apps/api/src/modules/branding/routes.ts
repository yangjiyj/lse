import type { FastifyInstance } from 'fastify';
import { prisma } from '../../db.js';
import { enforcePublicRateLimit } from '../../lib/public-rate-limit.js';
import { parseStoredTenant, TENANT_SETTING_KEY } from '../../lib/tenant-branding.js';

/** 每次整页加载都会调用（登录前后都是），比其他公开接口放宽；超限时前端退回默认标题和 logo。 */
export const BRANDING_REQUESTS_PER_MINUTE = 120;

/**
 * 公开只读品牌接口（无需登录）：登录页、浏览器页签标题与 favicon 在登录前就需要。
 * 只返回平台标题、logo（已在保存时校验为 PNG/JPG/ICO/WEBP 的 data URL）和技术支持联系方式，不含任何敏感配置。
 */
export async function brandingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request, reply) => {
    await enforcePublicRateLimit('branding', request.ip, {
      perMinute: BRANDING_REQUESTS_PER_MINUTE,
    });
    const row = await prisma.systemSetting.findUnique({ where: { key: TENANT_SETTING_KEY } });
    const tenant = parseStoredTenant(row?.value);
    reply.header('Cache-Control', 'no-cache');
    reply.header('X-Content-Type-Options', 'nosniff');
    return {
      platformTitle: tenant.platformTitle,
      platformLogo: tenant.platformLogo || null,
      tabLogo: tenant.tabLogo || null,
      supportOrg: tenant.supportOrg || null,
      contactName: tenant.contactName || null,
      contactPhone: tenant.contactPhone || null,
      contactEmail: tenant.contactEmail || null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  });
}
