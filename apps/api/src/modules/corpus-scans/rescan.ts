import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { CorpusScan, Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { writeAudit } from '../../lib/audit.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { enqueueCorpusScan } from '../../lib/queue.js';
import {
  assertCorpusDiskSpace,
  corpusFilePath,
  corpusUploadMaxBytes,
  removeCorpusFile,
  storeCorpusUpload,
} from './storage.js';

export interface RescanCorpusInput {
  sourceScanId: string;
  /** 不给沿用来源扫描的规则集；null 表示不用自定义规则集 */
  ruleSetId?: string | null;
  /** 不给沿用来源扫描的设置 */
  judgeReview?: boolean;
}

/**
 * 重扫一次已上传的语料（组合任务的子任务、页面「重新扫描」）：复制原文件建新扫描并入队，
 * 沿用来源扫描的格式、CSV 列和文件名。原文件超过保留期被清理了就 409。必须在租户范围内调用。
 */
export async function rescanCorpus(
  user: { id: string; username: string },
  input: RescanCorpusInput,
  ctx: { ip: string | null; userAgent: string | null },
): Promise<{ id: string; status: string }> {
  const source = await prisma.corpusScan.findFirst({ where: { id: input.sourceScanId } });
  if (!source) throw notFound('语料扫描不存在', 'CORPUS_SCAN_NOT_FOUND');
  const purged = () => conflict('原文件已超过保留期被清理，请重新上传', 'CORPUS_SOURCE_PURGED');
  if (source.filesPurgedAt) throw purged();
  const path = corpusFilePath(source.storageKey);
  const file = await stat(path).catch(() => null);
  if (!file?.isFile()) throw purged();

  const ruleSetId = input.ruleSetId === undefined ? source.ruleSetId : input.ruleSetId;
  if (ruleSetId && !(await prisma.corpusRuleSet.findFirst({ where: { id: ruleSetId } }))) {
    throw notFound('规则集不存在', 'CORPUS_RULE_SET_NOT_FOUND');
  }
  const judgeReview = input.judgeReview ?? source.judgeReview;

  await assertCorpusDiskSpace(Number(source.bytes));
  const copy = await storeCorpusUpload(createReadStream(path), corpusUploadMaxBytes());
  let scan: CorpusScan;
  try {
    scan = await prisma.corpusScan.create({
      data: {
        fileName: source.fileName,
        storageKey: copy.storageKey,
        bytes: BigInt(copy.bytes),
        sha256: copy.sha256,
        format: source.format,
        ...(source.csvColumns !== null
          ? { csvColumns: source.csvColumns as Prisma.InputJsonValue }
          : {}),
        ruleSetId,
        judgeReview,
        judgeLimit: source.judgeLimit,
        createdById: user.id,
      },
    });
  } catch (e) {
    await removeCorpusFile(copy.storageKey);
    throw e;
  }
  try {
    await enqueueCorpusScan(scan.id);
  } catch {
    await prisma.corpusScan.update({
      where: { id: scan.id },
      data: { status: 'FAILED', error: '扫描排队失败，请稍后重试', finishedAt: new Date() },
    });
    throw new AppError(503, '扫描排队失败，请稍后重试', 'CORPUS_SCAN_QUEUE_FAILED');
  }
  await writeAudit({
    actorId: user.id,
    actorName: user.username,
    action: 'corpus_scan.create',
    targetType: 'corpus_scan',
    targetId: scan.id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    detail: {
      fileName: scan.fileName,
      bytes: copy.bytes,
      sha256: copy.sha256,
      format: scan.format,
      ruleSetId,
      judgeReview,
      sourceScanId: source.id,
    },
  });
  return { id: scan.id, status: scan.status };
}
