import { assertNonEndpointTaskTargetId } from '../../lib/endpoint-task-policy.js';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AdrImportPreview } from './adr-import.js';

export const ADR_IMPORT_ENGINE = 'adr-sensor-import';
export const ADR_IMPORT_DIMENSION = 'agent_tool_call';

export interface PersistAdrImportInput {
  preview: AdrImportPreview;
  modelTargetId: string;
  modelTargetName: string;
  taskName?: string;
  createdById?: string | null;
  startedAt?: Date;
  durationMs?: number;
}

export interface AdrImportSummary {
  entryCount: number;
  messageCount: number;
  toolCallCount: number;
  findingCount: number;
  riskSessionCount: number;
  passedSessionCount: number;
  failedFindingCount: number;
  reviewFindingCount: number;
  truncatedSessionCount: number;
}

export function summarizeAdrImport(preview: AdrImportPreview): AdrImportSummary {
  const riskSessions = preview.sessions.filter((session) => session.findings.length > 0);
  const findings = preview.sessions.flatMap((session) => session.findings);
  return {
    entryCount: preview.entryCount,
    messageCount: preview.messageCount,
    toolCallCount: preview.toolCallCount,
    findingCount: preview.findingCount,
    riskSessionCount: riskSessions.length,
    passedSessionCount: preview.entryCount - riskSessions.length,
    failedFindingCount: findings.filter((finding) => finding.verdict === 'FAIL').length,
    reviewFindingCount: findings.filter((finding) => finding.verdict === 'UNKNOWN').length,
    truncatedSessionCount: preview.sessions.filter((session) => session.truncated).length,
  };
}

function defaultTaskName(targetName: string): string {
  const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  return `${targetName} 智能体轨迹导入分析 ${timestamp}`;
}

/**
 * 将 ADR-compatible JSON 的内存分析结果写入 LSE 标准任务模型。
 * 原始会话、session_id、主机名、用户名和路径都不会进入数据库。
 */
export async function persistAdrImportRun(
  prisma: PrismaClient,
  input: PersistAdrImportInput,
): Promise<{ taskId: string; summary: AdrImportSummary }> {
  await assertNonEndpointTaskTargetId(prisma, input.modelTargetId);
  const summary = summarizeAdrImport(input.preview);
  const startedAt = input.startedAt ?? new Date();
  const finishedAt = new Date();
  const sourceCounts = Object.fromEntries(
    [...new Set(input.preview.sessions.map((session) => session.source))].map((source) => [
      source,
      input.preview.sessions.filter((session) => session.source === source).length,
    ]),
  );

  return prisma.$transaction(async (tx) => {
    const task = await tx.evalTask.create({
      data: {
        name: input.taskName?.trim() || defaultTaskName(input.modelTargetName),
        description:
          '导入 ADR Sensor 兼容的智能体会话轨迹，由 LSE 规则引擎完成工具越权、敏感访问、数据外传、SSRF 与提示注入风险分析；不保存原始会话内容。',
        status: 'COMPLETED',
        modelTargetId: input.modelTargetId,
        engines: [ADR_IMPORT_ENGINE],
        dimensions: [ADR_IMPORT_DIMENSION],
        concurrency: 1,
        totalQuestions: summary.entryCount,
        processedQuestions: summary.entryCount,
        passedCount: summary.passedSessionCount,
        failedCount: summary.riskSessionCount,
        errorCount: 0,
        progress: 1,
        startedAt,
        finishedAt,
        createdById: input.createdById ?? null,
      },
    });

    const findingRows = input.preview.sessions.flatMap((session) =>
      session.findings.map(
        (finding, findingIndex): Prisma.FindingCreateManyInput => ({
          taskId: task.id,
          resultId: null,
          questionId: null,
          engine: ADR_IMPORT_ENGINE,
          riskCategory: finding.riskCategory,
          severity: finding.severity,
          score: finding.score,
          verdict: finding.verdict,
          title: finding.title,
          evidence: finding.evidence,
          suppressionKey: `adr:${session.sessionFingerprint}:${finding.riskCategory}:${findingIndex}`,
          detail: {
            ...finding.detail,
            trace: {
              source: session.source,
              sessionFingerprint: session.sessionFingerprint,
              timestamp: session.timestamp,
              model: session.model,
              messageCount: session.messageCount,
              toolCallCount: session.toolCallCount,
              chunked: session.chunked,
              truncated: session.truncated,
            },
          } as Prisma.InputJsonValue,
        }),
      ),
    );
    if (findingRows.length > 0) {
      await tx.finding.createMany({ data: findingRows });
    }

    await tx.engineRun.create({
      data: {
        taskId: task.id,
        resultId: null,
        engine: ADR_IMPORT_ENGINE,
        status: 'SUCCESS',
        startedAt,
        endedAt: finishedAt,
        durationMs: input.durationMs ?? Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        requestPayload: {
          format: 'adr-sensor-compatible-json',
          privacyMode: 'no-raw-conversation-persistence',
          sourceCounts,
          sessionFingerprints: input.preview.sessions.map((session) => session.sessionFingerprint),
        },
        rawOutput: JSON.stringify(summary),
        normalizedCount: summary.findingCount,
      },
    });

    await tx.evalTaskLog.create({
      data: {
        taskId: task.id,
        level: summary.riskSessionCount > 0 ? 'warn' : 'info',
        message:
          `轨迹导入分析完成：${summary.entryCount} 个会话、${summary.messageCount} 条消息、${summary.toolCallCount} 次工具调用；` +
          `发现 ${summary.findingCount} 项风险，涉及 ${summary.riskSessionCount} 个会话。` +
          (summary.truncatedSessionCount > 0
            ? ` 其中 ${summary.truncatedSessionCount} 个会话由采集器标记为截断，结论仅覆盖已导入部分。`
            : ''),
        context: summary as unknown as Prisma.InputJsonValue,
      },
    });

    return { taskId: task.id, summary };
  });
}
