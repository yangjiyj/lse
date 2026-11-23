import type { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '../../db.js';
import { collectFingerprint } from './collect.js';
import {
  compareFingerprints,
  DEFAULT_FINGERPRINT_THRESHOLD,
  FINGERPRINT_PROBE_VERSION,
  type ProbeFeature,
} from './similarity.js';

export type FingerprintCheckStatus = 'OK' | 'DRIFT' | 'FAILED' | 'NO_BASELINE';

/** 写入 EvalTask.fingerprintCheck 的结构 */
export interface FingerprintCheck {
  status: FingerprintCheckStatus;
  similarity: number | null;
  threshold: number;
  baselineId: string | null;
  fingerprintId: string | null;
  reason: string | null;
  checkedAt: string;
}

type Db = Pick<typeof defaultPrisma, 'modelTarget' | 'modelFingerprint' | 'evalTask'>;

export interface PreTaskCheckDeps {
  db?: Db;
  threshold?: number;
  signal?: AbortSignal;
  log?: (level: 'info' | 'warn', message: string, context?: Prisma.InputJsonValue) => Promise<void>;
}

/** 任务前比对阈值：环境变量 LSE_FINGERPRINT_DRIFT_THRESHOLD（0–1）可覆盖默认 0.6 */
export function resolveDriftThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LSE_FINGERPRINT_DRIFT_THRESHOLD?.trim();
  if (!raw) return DEFAULT_FINGERPRINT_THRESHOLD;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_FINGERPRINT_THRESHOLD;
}

/**
 * 任务前指纹比对：对象有基线时采集一次新指纹并与基线比对，结果写入 task.fingerprintCheck。
 * 永不抛出；失败或无基线都只记录状态，不阻断任务。
 */
export async function runPreTaskFingerprintCheck(
  taskId: string,
  modelTargetId: string,
  deps: PreTaskCheckDeps = {},
): Promise<FingerprintCheck> {
  const db = deps.db ?? defaultPrisma;
  const threshold = deps.threshold ?? resolveDriftThreshold();
  const check: FingerprintCheck = {
    status: 'NO_BASELINE',
    similarity: null,
    threshold,
    baselineId: null,
    fingerprintId: null,
    reason: null,
    checkedAt: new Date().toISOString(),
  };
  try {
    const baseline = await db.modelFingerprint.findFirst({
      where: { modelTargetId, isBaseline: true },
      select: { id: true, features: true, probeVersion: true },
    });
    if (!baseline) {
      check.reason = '该评估对象未设置指纹基线';
    } else if (baseline.probeVersion !== FINGERPRINT_PROBE_VERSION) {
      check.baselineId = baseline.id;
      check.status = 'FAILED';
      check.reason = `基线探针版本 ${baseline.probeVersion} 与当前 ${FINGERPRINT_PROBE_VERSION} 不一致，请重新采集基线`;
    } else {
      check.baselineId = baseline.id;
      try {
        const fp = await collectFingerprint(db, modelTargetId, {
          source: 'PRE_TASK',
          actor: { id: null, name: 'system' },
          signal: deps.signal,
        });
        check.fingerprintId = fp.id;
        const cmp = compareFingerprints(
          baseline.features as unknown as ProbeFeature[],
          fp.features as unknown as ProbeFeature[],
          { threshold },
        );
        check.similarity = cmp.similarity;
        check.status = cmp.drift ? 'DRIFT' : 'OK';
        check.reason = cmp.drift
          ? `相似度 ${cmp.similarity} 低于阈值 ${threshold}，被测模型可能已被替换或升级`
          : null;
      } catch (err) {
        check.status = 'FAILED';
        check.reason = `指纹采集失败：${(err as Error).message}`;
      }
    }
  } catch (err) {
    check.status = 'FAILED';
    check.reason = `指纹比对异常：${(err as Error).message}`;
  }

  try {
    await db.evalTask.update({
      where: { id: taskId },
      data: { fingerprintCheck: check as unknown as Prisma.InputJsonValue },
    });
  } catch (err) {
    console.error(`[fingerprint] 写入任务比对结果失败 taskId=${taskId}:`, (err as Error).message);
  }
  if (deps.log) {
    const ctx = check as unknown as Prisma.InputJsonValue;
    if (check.status === 'DRIFT') {
      await deps.log('warn', `模型指纹告警：${check.reason}`, ctx);
    } else if (check.status === 'FAILED') {
      await deps.log('warn', `模型指纹比对未完成（不影响任务执行）：${check.reason}`, ctx);
    } else if (check.status === 'OK') {
      await deps.log('info', `模型指纹比对通过，相似度 ${check.similarity}`, ctx);
    }
  }
  return check;
}
