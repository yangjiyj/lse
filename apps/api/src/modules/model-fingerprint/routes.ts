import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { authenticate, requirePermission } from '../../plugins/auth.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { requireLicensedFeature } from '../../lib/license-enforcement.js';
import {
  collectFingerprint,
  FingerprintCollectError,
  FINGERPRINT_PUBLIC_SELECT,
} from './collect.js';
import {
  compareFingerprints,
  DEFAULT_FINGERPRINT_THRESHOLD,
  FINGERPRINT_PROBES_V1,
  FINGERPRINT_PROBE_VERSION,
  type ProbeFeature,
} from './similarity.js';

const idParams = z.object({ id: z.string().uuid() });
const fpParams = z.object({ id: z.string().uuid(), fpId: z.string().uuid() });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const compareQuery = z.object({
  a: z.string().uuid(),
  b: z.string().uuid(),
  threshold: z.coerce.number().min(0).max(1).optional(),
});

async function assertTarget(id: string): Promise<void> {
  const t = await prisma.modelTarget.findUnique({ where: { id }, select: { id: true } });
  if (!t) throw notFound('评估对象不存在');
}

/** 模型指纹接口，挂在 /api/model-targets 前缀下；响应只含指纹字段，不含对象凭据。 */
export async function modelFingerprintRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get(
    '/:id/fingerprints',
    { preHandler: [requirePermission('model_target:read')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const { limit } = listQuery.parse(request.query ?? {});
      await assertTarget(id);
      const items = await prisma.modelFingerprint.findMany({
        where: { modelTargetId: id },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: FINGERPRINT_PUBLIC_SELECT,
      });
      const baseline = await prisma.modelFingerprint.findFirst({
        where: { modelTargetId: id, isBaseline: true },
        select: { id: true },
      });
      return {
        items,
        baselineId: baseline?.id ?? null,
        probeVersion: FINGERPRINT_PROBE_VERSION,
        probes: FINGERPRINT_PROBES_V1,
        defaultThreshold: DEFAULT_FINGERPRINT_THRESHOLD,
      };
    },
  );

  app.post(
    '/:id/fingerprints',
    { preHandler: [requirePermission('model_target:update'), requireLicensedFeature('web_ai')] },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      await assertTarget(id);
      const actor = request.currentUser!;
      try {
        const fp = await collectFingerprint(prisma, id, {
          source: 'MANUAL',
          actor: { id: actor.id, name: actor.username },
        });
        await writeAudit({
          actorId: actor.id,
          actorName: actor.username,
          action: 'model_fingerprint.collect',
          targetType: 'model_target',
          targetId: id,
          detail: { fingerprintId: fp.id, probeVersion: fp.probeVersion, status: 'SUCCESS' },
        });
        return reply.code(201).send(fp);
      } catch (err) {
        if (!(err instanceof FingerprintCollectError)) throw err;
        await writeAudit({
          actorId: actor.id,
          actorName: actor.username,
          action: 'model_fingerprint.collect',
          targetType: 'model_target',
          targetId: id,
          detail: { status: 'FAILED', error: err.message },
        });
        throw new AppError(502, `指纹采集失败：${err.message}`, 'FINGERPRINT_COLLECT_FAILED');
      }
    },
  );

  app.post(
    '/:id/fingerprints/:fpId/baseline',
    { preHandler: [requirePermission('model_target:update')] },
    async (request) => {
      const { id, fpId } = fpParams.parse(request.params);
      const fp = await prisma.modelFingerprint.findFirst({
        where: { id: fpId, modelTargetId: id },
        select: { id: true },
      });
      if (!fp) throw notFound('指纹不存在');
      const previous = await prisma.modelFingerprint.findFirst({
        where: { modelTargetId: id, isBaseline: true },
        select: { id: true },
      });
      const [, updated] = await prisma.$transaction([
        prisma.modelFingerprint.updateMany({
          where: { modelTargetId: id, isBaseline: true, NOT: { id: fpId } },
          data: { isBaseline: false },
        }),
        prisma.modelFingerprint.update({
          where: { id: fpId },
          data: { isBaseline: true },
          select: FINGERPRINT_PUBLIC_SELECT,
        }),
      ]);
      const actor = request.currentUser!;
      await writeAudit({
        actorId: actor.id,
        actorName: actor.username,
        action: 'model_fingerprint.set_baseline',
        targetType: 'model_target',
        targetId: id,
        detail: { fingerprintId: fpId, previousBaselineId: previous?.id ?? null },
      });
      return updated;
    },
  );

  app.get(
    '/:id/fingerprints/compare',
    { preHandler: [requirePermission('model_target:read')] },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const q = compareQuery.parse(request.query ?? {});
      const rows = await prisma.modelFingerprint.findMany({
        where: { modelTargetId: id, id: { in: [q.a, q.b] } },
        select: { id: true, features: true, probeVersion: true, createdAt: true, isBaseline: true, source: true },
      });
      const a = rows.find((r) => r.id === q.a);
      const b = rows.find((r) => r.id === q.b);
      if (!a || !b) throw notFound('指纹不存在');
      if (a.probeVersion !== b.probeVersion) throw badRequest('两个指纹的探针版本不同，无法比对');
      const comparison = compareFingerprints(
        a.features as unknown as ProbeFeature[],
        b.features as unknown as ProbeFeature[],
        q.threshold !== undefined ? { threshold: q.threshold } : {},
      );
      const meta = (r: typeof a) => ({
        id: r.id,
        probeVersion: r.probeVersion,
        createdAt: r.createdAt,
        isBaseline: r.isBaseline,
        source: r.source,
      });
      return { a: meta(a), b: meta(b), ...comparison };
    },
  );
}
