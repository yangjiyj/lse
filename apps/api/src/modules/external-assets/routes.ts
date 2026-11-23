import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { notFound } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { platformTenantForUser } from './tenant-binding.js';
import { assessmentBody, assessEvidence } from './assessment.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    return '{' + Object.keys(item).sort().map((key) => JSON.stringify(key) + ':' + canonical(item[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export async function externalAssetAssessmentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  // LSE administrators can inspect the reports accepted by this installation.
  // A service identity sees only its own submissions; source-provided tenant IDs
  // and terminal labels never grant access.
  app.get('/assessments', { preHandler: requirePermission('eval_task:read') }, async (request) => {
    const query = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(request.query);
    const all = request.currentUser!.permissions.has('user:read');
    const boundTenant = platformTenantForUser(request.currentUser!.id);
    const where = all ? {} : { createdById: request.currentUser!.id, sourceTenantId: boundTenant ?? '__unbound__' };
    const [rows, total] = await Promise.all([
      prisma.externalAssetAssessment.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.limit, take: query.limit }),
      prisma.externalAssetAssessment.count({ where }),
    ]);
    return { items: rows.map((row) => ({ id: row.id, source_request_id: row.sourceRequestId,
      source_tenant_id: row.sourceTenantId, source_asset_id: row.sourceAssetId,
      source_instance_id: row.sourceInstanceId, source_endpoint_id: row.sourceEndpointId,
      source_endpoint_asset_id: row.sourceEndpointAssetId, source_endpoint_name: row.sourceEndpointName,
      asset_type: row.assetType, content_hash: row.contentHash, ruleset_version: row.rulesetVersion,
      coverage: row.coverage, verdict: row.verdict, report: row.report, created_at: row.createdAt.toISOString() })), total, page: query.page, limit: query.limit };
  });

  app.post('/assessments', { preHandler: requirePermission('eval_task:create') }, async (request, reply) => {
    const body = assessmentBody.parse(request.body);
    const boundTenant = platformTenantForUser(request.currentUser!.id);
    if (!boundTenant) return reply.code(503).send({error:{code:'PLATFORM_TENANT_UNBOUND',message:'提交账号未配置可信平台租户映射'}});
    if (body.source_tenant_id !== boundTenant) return reply.code(403).send({error:{code:'PLATFORM_TENANT_MISMATCH',message:'提交租户与服务账号授权不符'}});
    const result = assessEvidence(body);
    const existing = await prisma.externalAssetAssessment.findFirst({ where: { sourceRequestId: body.source_request_id } });
    if (existing) {
      if (existing.createdById !== request.currentUser!.id || canonical(existing.report) !== canonical(result.report) || existing.sourceTenantId !== body.source_tenant_id || existing.sourceAssetId !== body.source_asset_id ||
          existing.sourceInstanceId !== body.source_instance_id || existing.sourceEndpointId !== (body.source_endpoint_id ?? null) ||
          existing.sourceEndpointAssetId !== (body.source_endpoint_asset_id ?? null) || existing.sourceEndpointName !== (body.source_endpoint_name ?? null) || existing.contentHash !== body.content_hash ||
          existing.rulesetVersion !== body.ruleset_version) {
        reply.code(409);
        return { error: { code: 'SOURCE_REQUEST_CONFLICT', message: '请求标识已绑定其他资产版本' } };
      }
      return { id: existing.id, source_request_id: existing.sourceRequestId,
        source_tenant_id: existing.sourceTenantId, source_asset_id: existing.sourceAssetId, source_instance_id: existing.sourceInstanceId,
        source_endpoint_id: existing.sourceEndpointId, source_endpoint_asset_id: existing.sourceEndpointAssetId, source_endpoint_name: existing.sourceEndpointName,
        content_hash: existing.contentHash, ruleset_version: existing.rulesetVersion,
        coverage: existing.coverage, verdict: existing.verdict, findings: existing.findings,
        report: existing.report, method: 'supplied_static_evidence_review',
        created_at: existing.createdAt.toISOString() };
    }
    const row = await prisma.externalAssetAssessment.create({
      data: {
        sourceRequestId: body.source_request_id,
        sourceTenantId: body.source_tenant_id,
        sourceAssetId: body.source_asset_id,
        sourceInstanceId: body.source_instance_id,
        sourceEndpointId: body.source_endpoint_id, sourceEndpointAssetId: body.source_endpoint_asset_id, sourceEndpointName: body.source_endpoint_name,
        assetType: body.asset_type,
        contentHash: body.content_hash,
        rulesetVersion: body.ruleset_version,
        coverage: result.coverage,
        verdict: result.verdict,
        findings: result.findings,
        report: result.report,
        createdById: request.currentUser!.id,
      },
    });
    await writeAudit({ actorId: request.currentUser!.id, action: 'external_asset.assess',
      targetType: 'external_asset_assessment', targetId: row.id,
      detail: { sourceTenantId: body.source_tenant_id, sourceAssetId: body.source_asset_id,
        contentHash: body.content_hash, verdict: result.verdict } });
    reply.code(201);
    return { id: row.id, source_request_id: row.sourceRequestId, source_tenant_id: row.sourceTenantId, ...result, source_asset_id: body.source_asset_id,
      source_instance_id: body.source_instance_id, source_endpoint_id: body.source_endpoint_id ?? null, source_endpoint_asset_id: body.source_endpoint_asset_id ?? null, source_endpoint_name: body.source_endpoint_name ?? null, content_hash: body.content_hash,
      ruleset_version: body.ruleset_version, created_at: row.createdAt.toISOString() };
  });
  app.get('/assessments/:id', { preHandler: requirePermission('eval_task:read', 'eval_task:create') }, async (request) => {
    const id = z.object({ id: z.string().uuid() }).parse(request.params).id;
    const row = await prisma.externalAssetAssessment.findUnique({ where: { id } });
    if (!row || (!request.currentUser!.permissions.has('user:read') && (row.createdById !== request.currentUser!.id || row.sourceTenantId !== platformTenantForUser(request.currentUser!.id)))) throw notFound('评估记录不存在');
    return { id: row.id, source_request_id: row.sourceRequestId, source_tenant_id: row.sourceTenantId, source_asset_id: row.sourceAssetId,
      source_instance_id: row.sourceInstanceId, source_endpoint_id: row.sourceEndpointId, source_endpoint_asset_id: row.sourceEndpointAssetId, source_endpoint_name: row.sourceEndpointName, asset_type: row.assetType,
      content_hash: row.contentHash, ruleset_version: row.rulesetVersion,
      coverage: row.coverage, verdict: row.verdict, findings: row.findings, report: row.report,
      method: 'supplied_static_evidence_review', created_at: row.createdAt.toISOString() };
  });
}
