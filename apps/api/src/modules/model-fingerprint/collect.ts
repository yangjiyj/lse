import type { Prisma, PrismaClient, ModelFingerprintSource } from '@prisma/client';
import type { LlmCallResult, LlmTargetConfig } from '@lse/shared';
import { chatComplete } from '../../lib/llm-client.js';
import { resolveServerTargetEgressContext } from '../../lib/target-egress-policy.js';
import { invokeEvaluationTarget } from '../eval-targets/invoker.js';
import {
  FINGERPRINT_PROBES_V1,
  FINGERPRINT_PROBE_VERSION,
  extractFeatures,
  truncateOutput,
  type ProbeOutput,
} from './similarity.js';

/** 固定随机种子：接口支持 seed 时用于提高可复现性 */
export const FINGERPRINT_SEED = 20260929;
const PROBE_TIMEOUT_MS = 20_000;
const PROBE_MAX_TOKENS = 256;

export class FingerprintCollectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FingerprintCollectError';
  }
}

type Db = Pick<PrismaClient, 'modelTarget' | 'modelFingerprint'>;

export interface CollectActor {
  id?: string | null;
  name?: string | null;
}

export interface CollectOptions {
  source: ModelFingerprintSource;
  actor?: CollectActor | null;
  signal?: AbortSignal;
}

/** 对外输出字段：不含任何凭据 */
export const FINGERPRINT_PUBLIC_SELECT = {
  id: true,
  modelTargetId: true,
  probeVersion: true,
  outputs: true,
  features: true,
  source: true,
  isBaseline: true,
  createdById: true,
  createdByName: true,
  createdAt: true,
} satisfies Prisma.ModelFingerprintSelect;

export type PublicFingerprint = Prisma.ModelFingerprintGetPayload<{
  select: typeof FINGERPRINT_PUBLIC_SELECT;
}>;

const SUPPORTED_TYPES = new Set(['MODEL', 'AGENT_API', 'PUBLIC_AGENT', 'PLATFORM_APP']);

function isSeedRejected(r: LlmCallResult): boolean {
  return r.status === 'ERROR' && (r.httpStatus === 400 || r.httpStatus === 422);
}

/**
 * 对评估对象发送固定探针集并保存指纹。
 * 模型对象走 OpenAI 兼容调用（temperature=0，附固定 seed；若接口以 400/422 拒绝则去掉 seed 重试），
 * 智能体应用走与评估相同的应用 API 调用器。出站均经现有目标出站校验。
 * 任一探针失败则整体失败、不落库，避免残缺指纹参与比对。
 */
export async function collectFingerprint(
  db: Db,
  targetId: string,
  opts: CollectOptions,
): Promise<PublicFingerprint> {
  const t = await db.modelTarget.findUnique({ where: { id: targetId } });
  if (!t) throw new FingerprintCollectError('评估对象不存在');
  if (!SUPPORTED_TYPES.has(t.targetType)) {
    throw new FingerprintCollectError(`该对象类型（${t.targetType}）不支持模型指纹采集`);
  }

  const baseParams = (t.defaultParams as Record<string, unknown> | null) ?? {};
  let useSeed = true;
  const cfgFor = (seed: boolean): LlmTargetConfig => ({
    baseUrl: t.baseUrl,
    apiKey: t.apiKey,
    model: t.model,
    extraHeaders: (t.extraHeaders as Record<string, string> | null) ?? null,
    defaultParams: seed ? { ...baseParams, seed: FINGERPRINT_SEED } : baseParams,
    egressContext: resolveServerTargetEgressContext(),
  });

  const outputs: ProbeOutput[] = [];
  for (const probe of FINGERPRINT_PROBES_V1) {
    if (opts.signal?.aborted) throw new FingerprintCollectError('采集已取消');
    const messages = [{ role: 'user' as const, content: probe.prompt }];
    let r: LlmCallResult;
    if (t.targetType === 'MODEL') {
      const callOpts = {
        timeoutMs: PROBE_TIMEOUT_MS,
        maxTokens: PROBE_MAX_TOKENS,
        temperature: 0,
        signal: opts.signal,
      };
      r = await chatComplete(cfgFor(useSeed), messages, callOpts);
      if (useSeed && isSeedRejected(r)) {
        useSeed = false;
        r = await chatComplete(cfgFor(false), messages, callOpts);
      }
    } else {
      r = await invokeEvaluationTarget(t, messages, {
        timeoutMs: PROBE_TIMEOUT_MS,
        signal: opts.signal,
        sessionId: `lse-fingerprint-${probe.id}`,
      });
    }
    if (r.status !== 'SUCCESS') {
      throw new FingerprintCollectError(
        `探针 ${probe.id} 调用失败：${r.error ?? '未知错误'}${r.httpStatus ? `（HTTP ${r.httpStatus}）` : ''}`,
      );
    }
    outputs.push({ probeId: probe.id, output: truncateOutput(r.content ?? '') });
  }

  const features = extractFeatures(outputs);
  return db.modelFingerprint.create({
    data: {
      modelTargetId: t.id,
      probeVersion: FINGERPRINT_PROBE_VERSION,
      outputs: outputs as unknown as Prisma.InputJsonValue,
      features: features as unknown as Prisma.InputJsonValue,
      source: opts.source,
      createdById: opts.actor?.id ?? null,
      createdByName: opts.actor?.name ?? null,
    },
    select: FINGERPRINT_PUBLIC_SELECT,
  });
}
