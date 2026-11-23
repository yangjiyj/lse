import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import {
  resolveAndAuthorizeTarget,
  resolveScannerScopePolicy,
  ScannerScopeError,
} from '../../lib/scanner-scope.js';
import { requirePermission } from '../../plugins/auth.js';
import { config } from '../../config.js';
import { postJson } from './http.js';
import { clipText, normalizeLegacySeverity } from './normalize-utils.js';

export const RELAY_AUDIT_ENGINE = 'relay-audit';

const bodySchema = z
  .object({
    taskId: z.string().uuid(),
    algorithm: z.enum(['quick', 'full']).default('quick'),
  })
  .strict();

const taskQuerySchema = z.object({ taskId: z.string().uuid() });

/** 引擎运行记录是任务子表（不带 tenantId）：按 ID 查之前先确认任务在本租户可见。 */
async function assertTaskVisible(taskId: string): Promise<void> {
  const task = await prisma.evalTask.findUnique({ where: { id: taskId }, select: { id: true } });
  if (!task) throw notFound('评估任务不存在');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseSseResult(text: string): Record<string, unknown> | null {
  const blocks = text.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    if (!/^event:\s*result\s*$/im.test(block)) continue;
    const dataLine = block.split(/\r?\n/).find((line) => line.startsWith('data:'));
    if (!dataLine) continue;
    try {
      const envelope = asRecord(JSON.parse(dataLine.slice(5).trim()));
      const data = envelope ? asRecord(envelope.data) : null;
      if (data) return data;
    } catch {
      continue;
    }
  }
  return null;
}

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

function findingsFromResult(data: Record<string, unknown>) {
  const detail = asRecord(data.detail);
  const items = detail && Array.isArray(detail.findings) ? detail.findings : [];
  return items.flatMap((item, index) => {
    const row = asRecord(item);
    if (!row) return [];
    const severity = String(row.severity ?? '').toLowerCase();
    if (['passed', 'pass', 'ok'].includes(severity)) return [];
    const probe = typeof row.probe === 'string' ? row.probe : 'relay_check_' + String(index + 1);
    const title = typeof row.title === 'string' ? row.title : probe;
    const evidence = typeof row.evidence === 'string' ? row.evidence : title;
    return [
      {
        riskCategory: /model|fingerprint|signature/i.test(probe)
          ? 'component_vulnerability'
          : 'ssrf_network_access',
        severity: normalizeLegacySeverity(row.severity),
        verdict: 'FAIL' as const,
        title: clipText(title, 200) ?? probe,
        evidence: clipText(evidence),
        detail: {
          v: 1,
          proof: 'RUNTIME_OBSERVED',
          probe,
          source: 'RELAY_AUDIT_CHECKER',
        },
      },
    ];
  });
}

export async function registerRelayAuditRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/relay-audit/scan',
    { preHandler: [requirePermission('engine:scan')] },
    async (request) => {
      const body = bodySchema.parse(request.body);
      const task = await prisma.evalTask.findUnique({
        where: { id: body.taskId },
        select: {
          id: true,
          modelTarget: { select: { baseUrl: true, apiKey: true, model: true } },
        },
      });
      if (!task) throw notFound('Evaluation task not found');

      try {
        const policy = resolveScannerScopePolicy(config.RELAY_AUDIT_SCOPE_POLICY_REF, {
          SERVICE_ASSURANCE_SCOPE_POLICIES: config.SERVICE_ASSURANCE_SCOPE_POLICIES,
        });
        await resolveAndAuthorizeTarget(task.modelTarget.baseUrl, policy);
      } catch (error) {
        if (error instanceof ScannerScopeError) {
          throw badRequest(error.message, error.code);
        }
        throw error;
      }

      const startedAt = new Date();
      let status: 'SUCCESS' | 'FAILED' = 'SUCCESS';
      let errorMessage: string | null = null;
      let raw: unknown = null;
      let findings: ReturnType<typeof findingsFromResult> = [];

      const response = await postJson(
        config.RELAY_AUDIT_CHECKER_URL.replace(/\/+$/, '') + '/api/v1/relay/check/stream',
        {
          algorithm: body.algorithm,
          base_url: task.modelTarget.baseUrl,
          api_key: task.modelTarget.apiKey,
          model: task.modelTarget.model,
        },
        120000,
      );
      raw = parseSseResult(response.text ?? '');
      if (!response.ok || !raw) {
        status = 'FAILED';
        errorMessage = response.error ?? 'Relay Checker returned no structured result';
      } else {
        findings = findingsFromResult(raw as Record<string, unknown>);
      }

      const endedAt = new Date();
      const run = await prisma.engineRun.create({
        data: {
          taskId: body.taskId,
          resultId: null,
          engine: RELAY_AUDIT_ENGINE,
          status,
          startedAt,
          endedAt,
          durationMs: endedAt.getTime() - startedAt.getTime(),
          requestPayload: {
            algorithm: body.algorithm,
            model: task.modelTarget.model,
            baseUrl: task.modelTarget.baseUrl,
          } as Prisma.InputJsonValue,
          rawOutput: JSON.stringify({
            status,
            findingCount: findings.length,
            resultAvailable: Boolean(raw),
            ...(errorMessage ? { error: errorMessage } : {}),
          }),
          normalizedCount: findings.length,
          ...(errorMessage ? { errorMessage } : {}),
        },
      });

      if (findings.length > 0) {
        await prisma.finding.createMany({
          data: findings.map((finding) => ({
            taskId: body.taskId,
            resultId: null,
            questionId: null,
            engine: RELAY_AUDIT_ENGINE,
            riskCategory: finding.riskCategory,
            severity: finding.severity,
            score: null,
            verdict: finding.verdict,
            title: finding.title,
            evidence: finding.evidence,
            detail: finding.detail as Prisma.InputJsonValue,
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
          engine: RELAY_AUDIT_ENGINE,
          algorithm: body.algorithm,
          model: task.modelTarget.model,
          status,
          normalizedCount: findings.length,
        },
      });

      return { runId: run.id, status, normalizedCount: findings.length };
    },
  );

  app.get(
    '/relay-audit/findings',
    { preHandler: [requirePermission('eval_task:read')] },
    async (request) => {
      const query = taskQuerySchema.parse(request.query);
      const rows = await prisma.finding.findMany({
        where: { taskId: query.taskId, engine: RELAY_AUDIT_ENGINE },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(serializeFinding);
    },
  );

  app.get(
    '/relay-audit/runs',
    { preHandler: [requirePermission('eval_task:read')] },
    async (request) => {
      const query = taskQuerySchema.parse(request.query);
      await assertTaskVisible(query.taskId);
      const rows = await prisma.engineRun.findMany({
        where: { taskId: query.taskId, engine: RELAY_AUDIT_ENGINE },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(serializeRun);
    },
  );
}
