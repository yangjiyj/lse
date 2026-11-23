import { Prisma } from '@prisma/client';
import { prisma } from '../../../db.js';
import { badRequest, conflict, notFound } from '../../../lib/errors.js';
import { AI_COMPONENT_ENGINE } from './service.js';
import { taxonomyForAiAssetRule } from './taxonomy.js';

/**
 * 显式把一次扫描的发现项关联到评估任务：只有这里会写 findings 表。
 * 写入的 Finding.resultId 为空（组件扫描不对应某道题的结果），报告按 taskId 取数时会作为任务级证据纳入；
 * detail.origin 标记来源扫描，便于报告/整改追溯。未关联的扫描永远不会出现在任何报告中。
 * 默认不带入已判定为误报的发现项。
 */
export async function linkScanToTask(
  scanId: string,
  taskId: string,
  opts: { includeFalsePositive: boolean },
): Promise<{ linkedCount: number; taskId: string; taskName: string }> {
  const scan = await prisma.aiComponentScan.findUnique({
    where: { id: scanId },
    include: { findings: true },
  });
  if (!scan) throw notFound('扫描记录不存在');
  if (scan.status !== 'COMPLETED') throw badRequest('扫描未成功完成，不能关联到评估任务', 'AI_COMPONENT_LINK_FAILED_SCAN');
  if (scan.linkedTaskId) throw conflict('该扫描已关联到评估任务，如需改关联请先重新扫描', 'AI_COMPONENT_ALREADY_LINKED');
  const task = await prisma.evalTask.findUnique({ where: { id: taskId }, select: { id: true, name: true } });
  if (!task) throw notFound('评估任务不存在');
  const targets = scan.findings.filter((f) => opts.includeFalsePositive || f.reviewStatus !== 'FALSE_POSITIVE');

  const linkedCount = await prisma.$transaction(async (tx) => {
    const now = new Date();
    await tx.engineRun.create({
      data: {
        taskId,
        resultId: null,
        engine: AI_COMPONENT_ENGINE,
        status: 'SUCCESS',
        startedAt: scan.createdAt,
        endedAt: scan.createdAt,
        durationMs: 0,
        requestPayload: { origin: 'ai_component_scan', scanId, assetName: scan.assetName, assetVersion: scan.assetVersion } as Prisma.InputJsonValue,
        rawOutput: JSON.stringify({ scanId, findingCount: targets.length }),
        normalizedCount: targets.length,
      },
    });
    for (const f of targets) {
      const created = await tx.finding.create({
        data: {
          taskId,
          resultId: null,
          questionId: null,
          engine: AI_COMPONENT_ENGINE,
          riskCategory: f.riskCategory,
          severity: f.severity,
          score: f.confidence,
          confidence: f.confidence,
          verdict: 'FAIL',
          reviewStatus: f.reviewStatus === 'CONFIRMED' ? 'CONFIRMED' : f.reviewStatus === 'FALSE_POSITIVE' ? 'FALSE_POSITIVE' : 'UNREVIEWED',
          reviewReason: f.reviewNote,
          remediationAction: f.remediation,
          remediationLocation: f.filePath ? `${f.filePath}${f.line ? `:${f.line}` : ''}` : null,
          title: `${scan.assetName}${scan.assetVersion ? ` ${scan.assetVersion}` : ''}：${f.title}`,
          evidence: f.evidence,
          detail: {
            v: 2,
            origin: { kind: 'ai_component_scan', scanId, findingId: f.id, assetName: scan.assetName, assetType: scan.assetType, assetVersion: scan.assetVersion },
            ruleId: f.ruleId,
            description: f.description,
            remediation: f.remediation,
            locations: f.locations,
            proof: 'STATIC',
            taxonomy: taxonomyForAiAssetRule(f.ruleId),
          } as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      await tx.aiComponentFinding.update({ where: { id: f.id }, data: { linkedFindingId: created.id } });
    }
    await tx.aiComponentScan.update({ where: { id: scanId }, data: { linkedTaskId: taskId, linkedAt: now } });
    return targets.length;
  });
  return { linkedCount, taskId: task.id, taskName: task.name };
}
