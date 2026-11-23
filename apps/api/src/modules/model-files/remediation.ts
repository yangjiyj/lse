import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  FindingRemediationStatus,
  FindingReviewStatus,
  type ModelFileFinding,
  type Prisma,
} from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { requirePermission } from '../../plugins/auth.js';

/**
 * 模型文件发现的复核与整改：与评估任务 Finding 同一套状态与规则（风险处置台口径），
 * 差异只在“复测”——以同一路径、已完成、晚于原扫描的复扫记录作为验证关闭依据。
 */
const idParams = z.object({ findingId: z.string().uuid() });
const text = (max: number) =>
  z.preprocess(
    (v) => (v === '' || v == null ? null : v),
    z.string().trim().max(max).nullable().optional(),
  );
const reviewSchema = z.object({ status: z.nativeEnum(FindingReviewStatus), reason: text(4000) }).strict();
const updateSchema = z
  .object({
    status: z.nativeEnum(FindingRemediationStatus).optional(),
    owner: text(128),
    action: text(4000),
    dueAt: z.preprocess(
      (v) => (v === '' || v == null ? null : v),
      z.string().datetime({ offset: true }).nullable().optional(),
    ),
    record: text(4000),
    closureEvidence: text(4000),
    retestScanId: z.preprocess(
      (v) => (v === '' || v == null ? null : v),
      z.string().uuid().nullable().optional(),
    ),
  })
  .strict();

const include = {
  scan: { select: { id: true, path: true, source: true, createdById: true, createdAt: true, targetId: true } },
} as const;
type Row = ModelFileFinding & { scan: { id: string; path: string; createdById: string | null; createdAt: Date } };

const nonBlank = (v: string | null | undefined): v is string => typeof v === 'string' && v.trim().length > 0;

async function load(req: FastifyRequest): Promise<Row> {
  const { findingId } = idParams.parse(req.params);
  const row = await prisma.modelFileFinding.findUnique({ where: { id: findingId }, include });
  if (!row) throw notFound('模型文件发现不存在', 'MODEL_FILE_FINDING_NOT_FOUND');
  const u = req.currentUser!;
  if (!u.isBuiltin && row.scan.createdById !== u.id)
    throw forbidden('只能处置自己发起扫描中的发现', 'MODEL_FILE_FINDING_ACCESS_DENIED');
  return row;
}

function audit(req: FastifyRequest, action: string, id: string, detail: unknown) {
  return writeAudit({
    actorId: req.currentUser!.id,
    actorName: req.currentUser!.username,
    action,
    targetType: 'model_file_finding',
    targetId: id,
    ip: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
    detail,
  });
}

export async function modelFileRemediationRoutes(app: FastifyInstance): Promise<void> {
  app.patch(
    '/findings/:findingId/review',
    { preHandler: [requirePermission('remediation:update')] },
    async (req) => {
      const cur = await load(req);
      const b = reviewSchema.parse(req.body);
      if (cur.remediationStatus === 'VERIFIED_CLOSED' && b.status !== cur.reviewStatus)
        throw conflict('已验证关闭的整改项只能先重新打开，再修改复核结论。', 'REMEDIATION_CLOSED_IMMUTABLE');
      if (b.status !== 'UNREVIEWED' && !nonBlank(b.reason))
        throw conflict('人工复核必须填写复核依据。', 'FINDING_REVIEW_REASON_REQUIRED');
      const finding = await prisma.modelFileFinding.update({
        where: { id: cur.id },
        data: { reviewStatus: b.status, reviewReason: b.status === 'UNREVIEWED' ? null : b.reason },
        include,
      });
      await audit(req, 'model_file_finding.review', cur.id, { reviewStatus: b.status });
      return { finding };
    },
  );

  app.patch(
    '/findings/:findingId',
    { preHandler: [requirePermission('remediation:update')] },
    async (req) => {
      const cur = await load(req);
      const b = updateSchema.parse(req.body);
      const next = b.status ?? cur.remediationStatus;
      if (cur.remediationStatus === 'VERIFIED_CLOSED' && next !== 'REOPENED')
        throw conflict('已验证关闭的整改项只能通过重新打开后修改。', 'REMEDIATION_CLOSED_IMMUTABLE');
      if (next === 'NOT_APPLICABLE' && !nonBlank(b.record ?? cur.remediationRecord))
        throw conflict('标记不适用必须填写处置记录和适用性依据。', 'REMEDIATION_NOT_APPLICABLE_REASON_REQUIRED');
      if (next === 'VERIFIED_CLOSED') {
        if (cur.reviewStatus === 'ACCEPTED_RISK')
          throw conflict('风险接受不能计为修复或验证关闭。', 'REMEDIATION_ACCEPTED_RISK_NOT_CLOSED');
        if (cur.reviewStatus !== 'CONFIRMED')
          throw conflict('只有人工确认的风险才能验证关闭。', 'REMEDIATION_REVIEW_REQUIRED');
        if (!nonBlank(b.closureEvidence ?? cur.remediationClosureEvidence))
          throw conflict('验证关闭必须填写关闭证据。', 'REMEDIATION_CLOSURE_EVIDENCE_REQUIRED');
        const retestId = b.retestScanId ?? cur.remediationRetestScanId;
        if (!retestId) throw conflict('验证关闭必须关联复扫记录。', 'REMEDIATION_RETEST_REQUIRED');
        const retest = await prisma.modelFileScan.findUnique({
          where: { id: retestId },
          select: { id: true, status: true, path: true, createdAt: true, truncatedCount: true },
        });
        if (!retest || retest.status !== 'COMPLETED' || retest.id === cur.scanId || retest.truncatedCount > 0)
          throw conflict('复扫必须是另一次已完成且非部分结果的扫描。', 'REMEDIATION_RETEST_INCOMPLETE');
        if (retest.path !== cur.scan.path || retest.createdAt <= cur.scan.createdAt)
          throw conflict('复扫必须是对同一路径、晚于原扫描的扫描。', 'REMEDIATION_RETEST_SCOPE_MISMATCH');
        const repeated = await prisma.modelFileFinding.count({
          where: {
            scanId: retest.id,
            filePath: cur.filePath,
            ruleId: cur.ruleId,
            reviewStatus: { not: 'FALSE_POSITIVE' },
          },
        });
        if (repeated > 0) {
          const finding = await prisma.modelFileFinding.update({
            where: { id: cur.id },
            data: {
              remediationStatus: 'REOPENED',
              remediationRetestScanId: retest.id,
              remediationClosedAt: null,
              remediationClosureEvidence: null,
              remediationRecord: '复扫仍命中同一文件的同一规则，已自动重开。',
            },
            include,
          });
          await audit(req, 'model_file_finding.reopened_by_retest', cur.id, { retestScanId: retest.id });
          return { reopened: true, finding };
        }
      }
      const data: Prisma.ModelFileFindingUpdateInput = {
        remediationStatus: next,
        ...(b.owner !== undefined ? { remediationOwner: b.owner } : {}),
        ...(b.action !== undefined ? { remediationAction: b.action } : {}),
        ...(b.dueAt !== undefined ? { remediationDueAt: b.dueAt ? new Date(b.dueAt) : null } : {}),
        ...(b.record !== undefined ? { remediationRecord: b.record } : {}),
        ...(b.closureEvidence !== undefined ? { remediationClosureEvidence: b.closureEvidence } : {}),
        ...(b.retestScanId !== undefined ? { remediationRetestScanId: b.retestScanId } : {}),
        ...(next === 'VERIFIED_CLOSED'
          ? { remediationClosedAt: new Date() }
          : next === 'REOPENED'
            ? { remediationClosedAt: null }
            : {}),
      };
      const finding = await prisma.modelFileFinding.update({ where: { id: cur.id }, data, include });
      await audit(req, 'model_file_finding.update', cur.id, { status: next, retestScanId: b.retestScanId ?? null });
      return { reopened: false, finding };
    },
  );
}

const OPEN_REMEDIATION = { notIn: ['VERIFIED_CLOSED', 'NOT_APPLICABLE'] as FindingRemediationStatus[] };
/** 看板待办：模型文件发现（中危及以上）的待复核数、7 天内到期/已逾期整改数与明细。 */
export async function modelFileTodos(canReadRemediation: boolean) {
  const now = new Date();
  const dueLimit = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  const base: Prisma.ModelFileFindingWhereInput = { severity: { in: ['CRITICAL', 'HIGH', 'MEDIUM'] } };
  const reviewWhere = { ...base, reviewStatus: { in: ['UNREVIEWED', 'NEEDS_REVIEW'] as FindingReviewStatus[] } };
  const dueWhere = { ...base, remediationDueAt: { lte: dueLimit }, remediationStatus: OPEN_REMEDIATION };
  const [reviewCount, remediationCount, rows] = await Promise.all([
    prisma.modelFileFinding.count({ where: reviewWhere }),
    canReadRemediation ? prisma.modelFileFinding.count({ where: dueWhere }) : Promise.resolve(0),
    prisma.modelFileFinding.findMany({
      where: canReadRemediation ? { OR: [reviewWhere, dueWhere] } : reviewWhere,
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: 10,
      select: { id: true, scanId: true, filePath: true, title: true, severity: true, remediationDueAt: true, reviewStatus: true },
    }),
  ]);
  return {
    reviewCount,
    remediationCount,
    items: rows.map((r) => ({
      ...r,
      overdue: r.remediationDueAt ? r.remediationDueAt < now : false,
    })),
  };
}
