import type { LlmTargetConfig } from '@lse/shared';
import { PLATFORM_TENANT_ID } from '../../lib/tenant-models.js';

/** DB 里激活的 JUDGE ModelTarget 候选（仅取裁决与解耦校验所需字段）。 */
export interface JudgeCandidate {
  id?: string | null;
  baseUrl: string;
  apiKey: string;
  model: string;
  extraHeaders?: Record<string, string> | null;
  defaultParams?: Record<string, unknown> | null;
}

/** 被测对象（SUT）引用，用于强制「评审 ≠ 被测」。 */
export interface SutRef {
  id: string;
  baseUrl: string;
  model: string;
}

function isBlank(value: string | null | undefined): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

/**
 * 选定 llm-judge 使用的「评审模型」配置：把 DB 里激活的 JUDGE 候选归一化为 LlmTargetConfig。
 *
 * 评审对象必须与被测对象（SUT）解耦，否则就是模型给自己打分。返回 null 的情形：
 * - 候选缺失（未配置全局评审模型）；
 * - baseUrl/apiKey/model 任一为空（视为未配置）；
 * - 候选与 SUT 是同一行（id 相同）——禁止自评；
 * - 候选与 SUT 指向同一端点 + 同一模型——同端点自评。
 *
 * 返回 null 时，调用方应回退到环境变量 LLM_JUDGE_*，或不启用 llm-judge。
 */
export function pickJudgeTarget(
  candidate: JudgeCandidate | null | undefined,
  sut: SutRef,
): LlmTargetConfig | null {
  if (!candidate) return null;
  if (isBlank(candidate.baseUrl) || isBlank(candidate.apiKey) || isBlank(candidate.model)) {
    return null;
  }
  if (candidate.id && candidate.id === sut.id) return null;
  if (candidate.baseUrl === sut.baseUrl && candidate.model === sut.model) return null;

  return {
    baseUrl: candidate.baseUrl,
    apiKey: candidate.apiKey,
    model: candidate.model,
    extraHeaders: candidate.extraHeaders ?? null,
    defaultParams: candidate.defaultParams ?? null,
  };
}

/** DB 里 JUDGE ModelTarget 行（仅取裁决所需字段）。 */
interface JudgeRow {
  id: string;
  name: string;
  baseUrl: string | null;
  apiKey: string | null;
  model: string | null;
  extraHeaders?: unknown;
  defaultParams?: unknown;
  lastTestStatus: string | null;
}

/** 最小化的 prisma 读取面，便于以假对象单测，避免真连库。 */
export interface JudgeTargetStore {
  modelTarget: {
    findFirst(args: unknown): Promise<JudgeRow | null>;
  };
}

export interface SelectedJudgeTarget extends JudgeCandidate {
  id: string;
  name: string;
  lastTestStatus: string | null;
}

export type JudgeTargetSelection =
  | { found: false; target: null }
  | { found: true; target: SelectedJudgeTarget | null };

/** 选择最新启用且配置完整的独立判定模型，并保留客户展示所需的安全元数据。 */
export async function selectLatestActiveJudgeTarget(
  store: JudgeTargetStore,
  opts: { platformOnly?: boolean } = {},
): Promise<JudgeTargetSelection> {
  const row = await store.modelTarget.findFirst({
    // platformOnly：只取平台的模型（平台共享的 tenantId 为空，平台租户自己的为平台租户 ID），
    // 平台级任务不得使用其他租户的私有模型与密钥。
    where: {
      targetType: 'JUDGE',
      isActive: true,
      ...(opts.platformOnly ? { OR: [{ tenantId: null }, { tenantId: PLATFORM_TENANT_ID }] } : {}),
    },
    orderBy: { updatedAt: 'desc' },
  });
  if (!row) return { found: false, target: null };
  if (isBlank(row.baseUrl) || isBlank(row.apiKey) || isBlank(row.model)) {
    return { found: true, target: null };
  }
  return {
    found: true,
    target: {
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl!.trim(),
      apiKey: row.apiKey!.trim(),
      model: row.model!.trim(),
      extraHeaders: (row.extraHeaders as Record<string, string> | null | undefined) ?? null,
      defaultParams: (row.defaultParams as Record<string, unknown> | null | undefined) ?? null,
      lastTestStatus: row.lastTestStatus ?? null,
    },
  };
}

/**
 * 解析「全局评审模型」：查激活的 JUDGE ModelTarget（按 updatedAt 取最新一行），
 * 再经 pickJudgeTarget 强制评审 ≠ 被测。返回三态，直接喂给 resolvePerQuestionEngines：
 * - undefined：未配置 JUDGE 行 → 调用方回退环境变量 LLM_JUDGE_*（向后兼容）；
 * - null：行存在但自评 / 字段不完整 → 不启用 llm-judge（故障安全，不静默回退环境变量）；
 * - LlmTargetConfig：有效且区别于 SUT。
 */
export async function loadActiveJudgeTarget(
  store: JudgeTargetStore,
  sut: SutRef,
): Promise<LlmTargetConfig | null | undefined> {
  const selected = await selectLatestActiveJudgeTarget(store);
  if (!selected.found) return undefined;
  if (!selected.target) return null;
  return pickJudgeTarget(selected.target, sut);
}
