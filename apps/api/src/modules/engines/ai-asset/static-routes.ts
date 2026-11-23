import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../../db.js';
import { badRequest, notFound } from '../../../lib/errors.js';
import { writeAudit } from '../../../lib/audit.js';
import { requirePermission } from '../../../plugins/auth.js';
import { scanAiAssetFiles } from './static-scan.js';

/** 引擎运行记录是任务子表（不带 tenantId）：按 ID 查之前先确认任务在本租户可见。 */
async function assertTaskVisible(taskId: string): Promise<void> {
  const task = await prisma.evalTask.findUnique({ where: { id: taskId }, select: { id: true } });
  if (!task) throw notFound('评估任务不存在');
}

const staticFileSchema = z
  .object({
    path: z.string().trim().min(1).max(255),
    content: z.string().max(512 * 1024),
  })
  .strict();

const staticScanBodySchema = z
  .object({
    taskId: z.string().uuid(),
    assetType: z.enum(['SKILL', 'MCP_SERVER']),
    source: z.string().trim().max(500).optional(),
    files: z.array(staticFileSchema).min(1).max(200),
  })
  .strict();

const taskQuerySchema = z.object({ taskId: z.string().uuid() });

function serializeFinding(row: {
  id: string;
  taskId: string;
  engine: string;
  riskCategory: string;
  severity: string | null;
  verdict: string;
  title: string | null;
  evidence: string | null;
  detail: unknown;
  createdAt: Date;
}) {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

function serializeRun(row: {
  id: string;
  taskId: string;
  engine: string;
  status: string;
  startedAt: Date | null;
  endedAt: Date | null;
  durationMs: number | null;
  normalizedCount: number | null;
  errorMessage: string | null;
  createdAt: Date;
}) {
  return {
    ...row,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export const AI_ASSET_STATIC_ENGINE = 'skill-mcp-static';

export async function registerAiAssetStaticRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/ai-asset/static-scan',
    { preHandler: [requirePermission('engine:scan')] },
    async (request) => {
      const body = staticScanBodySchema.parse(request.body);
      const task = await prisma.evalTask.findUnique({
        where: { id: body.taskId },
        select: { id: true },
      });
      if (!task) throw notFound('Evaluation task not found');

      const startedAt = new Date();
      const findings = scanAiAssetFiles({
        assetType: body.assetType,
        source: body.source,
        files: body.files,
      });
      const endedAt = new Date();
      const requestPayload = {
        taskId: body.taskId,
        assetType: body.assetType,
        source: body.source ?? null,
        files: body.files.map((file) => ({
          path: file.path,
          bytes: Buffer.byteLength(file.content, 'utf8'),
        })),
      };

      const run = await prisma.engineRun.create({
        data: {
          taskId: body.taskId,
          resultId: null,
          engine: AI_ASSET_STATIC_ENGINE,
          status: 'SUCCESS',
          startedAt,
          endedAt,
          durationMs: endedAt.getTime() - startedAt.getTime(),
          requestPayload: requestPayload as Prisma.InputJsonValue,
          rawOutput: JSON.stringify({
            assetType: body.assetType,
            source: body.source ?? null,
            findingCount: findings.length,
          }),
          normalizedCount: findings.length,
        },
      });

      if (findings.length > 0) {
        await prisma.finding.createMany({
          data: findings.map((finding) => ({
            taskId: body.taskId,
            resultId: null,
            questionId: null,
            engine: AI_ASSET_STATIC_ENGINE,
            riskCategory: finding.riskCategory,
            severity: finding.severity,
            score: finding.confidence ?? null,
            verdict: finding.status === 'FAIL' ? 'FAIL' : 'UNKNOWN',
            title: finding.title,
            evidence: finding.evidence[0]?.excerpt ?? null,
            detail: {
              v: 1,
              assetType: finding.assetType,
              ruleId: finding.ruleId,
              status: finding.status,
              proof: finding.evidence[0]?.proof ?? 'STATIC',
              evidence: finding.evidence,
              taxonomy: finding.taxonomy,
              remediation: finding.remediation ?? null,
            } as unknown as Prisma.InputJsonValue,
          })),
        });
      }

      await writeAudit({
        actorId: request.currentUser!.id,
        actorName: request.currentUser!.username,
        action: 'engine.scan',
        targetType: 'eval_task',
        targetId: body.taskId,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        detail: {
          engine: AI_ASSET_STATIC_ENGINE,
          assetType: body.assetType,
          source: body.source ?? null,
          fileCount: body.files.length,
          normalizedCount: findings.length,
        },
      });

      return { runId: run.id, status: 'SUCCESS', normalizedCount: findings.length };
    },
  );

  app.get(
    '/ai-asset/findings',
    { preHandler: [requirePermission('eval_task:read')] },
    async (request) => {
      const query = taskQuerySchema.parse(request.query);
      const rows = await prisma.finding.findMany({
        where: { taskId: query.taskId, engine: AI_ASSET_STATIC_ENGINE },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(serializeFinding);
    },
  );

  app.get(
    '/ai-asset/runs',
    { preHandler: [requirePermission('eval_task:read')] },
    async (request) => {
      const query = taskQuerySchema.parse(request.query);
      await assertTaskVisible(query.taskId);
      const rows = await prisma.engineRun.findMany({
        where: { taskId: query.taskId, engine: AI_ASSET_STATIC_ENGINE },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(serializeRun);
    },
  );
}
