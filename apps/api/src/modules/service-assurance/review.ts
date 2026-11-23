import { z } from 'zod';
import { prisma } from '../../db.js';
import { conflict, notFound } from '../../lib/errors.js';
import { readExecutionChecks, EXECUTION_EVIDENCE_TYPE } from './execution-evidence.js';
import { assessOriginalRiskRetest } from './retest-evidence.js';
import { serviceAssuranceSbomUploadSchema } from './contracts.js';
import {
  buildFixedDecision,
  buildNotAffectedDecision,
  OPENVEX_NOT_AFFECTED_JUSTIFICATIONS,
} from './vex.js';

const statementSchema = z.string().trim().min(1).max(1_000);

export const serviceAssuranceReviewBodySchema = z.discriminatedUnion('impactStatus', [
  z
    .object({
      impactStatus: z.literal('UNDER_INVESTIGATION'),
      statement: statementSchema,
    })
    .strict(),
  z
    .object({
      impactStatus: z.literal('AFFECTED'),
      statement: statementSchema,
    })
    .strict(),
  z
    .object({
      impactStatus: z.literal('NOT_AFFECTED'),
      justification: z.enum(OPENVEX_NOT_AFFECTED_JUSTIFICATIONS),
      statement: statementSchema,
    })
    .strict(),
  z
    .object({
      impactStatus: z.literal('FIXED'),
      retestRunId: z.string().uuid(),
      statement: statementSchema,
    })
    .strict(),
]);

export const serviceAssuranceRetestBodySchema = z
  .object({
    sbom: serviceAssuranceSbomUploadSchema.optional(),
  })
  .strict();

export type ServiceAssuranceReviewBody = z.infer<typeof serviceAssuranceReviewBodySchema>;

export async function reviewServiceAssuranceAssessment(input: {
  assessmentId: string;
  actorId: string;
  body: ServiceAssuranceReviewBody;
  now?: Date;
}) {
  const assessment = await prisma.vulnerabilityAssessment.findUnique({
    where: { id: input.assessmentId },
    include: {
      run: {
        select: { id: true, taskId: true, mode: true, targetKind: true, normalizedTarget: true },
      },
      component: { select: { purl: true } },
      evidence: { select: { sourceTool: true, ruleId: true, matchedLocation: true } },
    },
  });
  if (!assessment) {
    throw notFound('服务安全核验结论不存在', 'SERVICE_ASSURANCE_ASSESSMENT_NOT_FOUND');
  }

  if (assessment.impactStatus === 'FIXED' && input.body.impactStatus !== 'FIXED') {
    throw conflict(
      '已修复结论只能通过新的核验运行重新发现风险。',
      'SERVICE_ASSURANCE_REVIEW_TRANSITION_INVALID',
    );
  }

  const reviewedAt = input.now ?? new Date();
  let reason = input.body.statement;
  let fixedByRunId: string | null = null;
  let moveFindingToHistory = false;

  if (input.body.impactStatus === 'AFFECTED') {
    if (assessment.evidenceLevel === 'LEAD') {
      throw conflict(
        '当前证据仅为待核验线索，不能升级为正式风险。',
        'SERVICE_ASSURANCE_EVIDENCE_INSUFFICIENT',
      );
    }
    if (!assessment.findingId) {
      throw conflict('当前结论没有可关联的正式风险证据。', 'SERVICE_ASSURANCE_FINDING_REQUIRED');
    }
  } else if (input.body.impactStatus === 'NOT_AFFECTED') {
    const decision = buildNotAffectedDecision({
      justification: input.body.justification,
      statement: input.body.statement,
    });
    reason = decision.reason;
    moveFindingToHistory = true;
  } else if (input.body.impactStatus === 'FIXED') {
    if (assessment.impactStatus !== 'AFFECTED') {
      throw conflict(
        '只有已确认风险可以更新为已修复。',
        'SERVICE_ASSURANCE_REVIEW_TRANSITION_INVALID',
      );
    }
    const retestRun = await prisma.serviceAssuranceRun.findUnique({
      where: { id: input.body.retestRunId },
      select: {
        id: true,
        taskId: true,
        retestOfRunId: true,
        status: true,
        coverageStatus: true,
        endedAt: true,
        mode: true,
        targetKind: true,
        normalizedTarget: true,
        evidence: { where: { evidenceType: EXECUTION_EVIDENCE_TYPE } },
        assessments: {
          include: {
            component: { select: { purl: true } },
            evidence: { select: { sourceTool: true, ruleId: true, matchedLocation: true } },
          },
        },
      },
    });
    if (
      !retestRun ||
      retestRun.mode !== assessment.run.mode ||
      retestRun.targetKind !== assessment.run.targetKind ||
      retestRun.normalizedTarget !== assessment.run.normalizedTarget
    ) {
      throw conflict(
        '复测必须关联原运行，并证明原问题对应的检查已完成且问题未再出现。',
        'SERVICE_ASSURANCE_RETEST_NOT_SUCCESSFUL',
      );
    }
    try {
      const decision = buildFixedDecision({
        originalRun: assessment.run,
        retestRun: {
          ...retestRun,
          ...assessOriginalRiskRetest(
            assessment,
            retestRun.assessments,
            readExecutionChecks(retestRun.evidence),
          ),
        },
        statement: input.body.statement,
      });
      reason = decision.reason;
      fixedByRunId = decision.fixedByRunId;
      moveFindingToHistory = true;
    } catch {
      throw conflict(
        '复测必须关联原运行，并证明原问题对应的检查已完成且问题未再出现。',
        'SERVICE_ASSURANCE_RETEST_NOT_SUCCESSFUL',
      );
    }
  } else {
    moveFindingToHistory = true;
  }

  return prisma.vulnerabilityAssessment.update({
    where: { id: assessment.id },
    data: {
      impactStatus: input.body.impactStatus,
      reason,
      reviewedById: input.actorId,
      reviewedAt,
      reviewNote: input.body.statement,
      decidedAt: reviewedAt,
      fixedByRunId,
      findingId: moveFindingToHistory ? null : undefined,
      legacyFindingId: moveFindingToHistory
        ? (assessment.findingId ?? assessment.legacyFindingId)
        : undefined,
    },
    select: {
      impactStatus: true,
      reason: true,
      reviewedAt: true,
    },
  });
}
