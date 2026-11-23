import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { requirePermission } from '../../plugins/auth.js';
import { currentTenantId } from '../../lib/tenant-context.js';

/** 仍需关注的研判结论：排除“已确认不受影响”和“已修复”。 */
const OPEN_IMPACT: Prisma.VulnerabilityAssessmentWhereInput['impactStatus'] = {
  in: ['AFFECTED', 'UNDER_INVESTIGATION'],
};

/**
 * AI 应用组件安全统计口径：
 * - AI应用组件数：服务核验识别出的组件，按 componentKey 去重（同一组件多次核验只计一次）。
 * - 漏洞数：有公开漏洞编号（advisoryId，如 CVE）的研判结论，且影响状态为受影响或待核验。
 * - 基线问题数：无漏洞编号、证据等级为配置匹配（CONFIG_MATCH）的配置类发现，且影响状态为受影响或待核验。
 */
export async function componentSecurityStats() {
  const [componentKeys, vulnerabilityCount, baselineIssueCount, runCount] = await Promise.all([
    // 组件是服务核验的子表（不带 tenantId），按父对象 run 的租户限定。
    prisma.serviceComponent.groupBy({
      by: ['componentKey'],
      where: currentTenantId() ? { run: { tenantId: currentTenantId()! } } : {},
    }),
    prisma.vulnerabilityAssessment.count({
      where: { advisoryId: { not: null }, impactStatus: OPEN_IMPACT },
    }),
    prisma.vulnerabilityAssessment.count({
      where: { advisoryId: null, evidenceLevel: 'CONFIG_MATCH', impactStatus: OPEN_IMPACT },
    }),
    prisma.serviceAssuranceRun.count(),
  ]);
  return {
    componentCount: componentKeys.length,
    vulnerabilityCount,
    baselineIssueCount,
    runCount,
  };
}

export async function componentSecurityRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/component-security',
    { preHandler: [requirePermission('service_assurance:read')] },
    async () => componentSecurityStats(),
  );
}
