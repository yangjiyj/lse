import type { QuestionType, Severity } from '@lse/shared';
import { getBenchmarkSample, loadBenchmarkSample } from './samples.js';

/**
 * 开箱即用的内置题集种子。
 *
 * 平台自有撰写的 CC0-1.0 样例集（见 samples.ts）本应登录即可用，但此前仅能
 * 经「测评基准」弹窗手动导入，导致新部署的「问题集管理」是空的、用户误以为
 * 必须自带题目。此模块把样例集映射成可直接落库的「题集 + 题目」载荷，
 * 供 prisma/seed.ts 在初始化时幂等写入。
 *
 * 仅内置 CC0 自有授权样例；外部基准（SALAD-Bench / JADE 等多为 CC-BY-NC /
 * 仅研究用途）不随产品内置数据本体，只提供格式适配器，由用户自带导入。
 */

export const BUILTIN_SAMPLE_ID = 'lse-safety-mini';

/** 与 Question 模型 createMany 入参同构的单条题目载荷。 */
export interface BuiltinQuestionSeed {
  externalId: string | null;
  content: string;
  category: string | null;
  expectedBehavior: string | null;
  referenceAnswer: string | null;
  type: QuestionType;
  severity: Severity | null;
  shouldRefuse: boolean;
  language: string;
  tags: string[];
}

/** 一个内置题集 + 其题目，含幂等键 source。 */
export interface BuiltinQuestionSetSeed {
  /** 幂等键：与基准导入路由一致（benchmark:<sampleId>），seed 据此判重。 */
  source: string;
  name: string;
  description: string;
  type: QuestionType;
  tags: string[];
  isBuiltin: true;
  questions: BuiltinQuestionSeed[];
}

export type BuiltinQuestionIdentityInput = Pick<
  BuiltinQuestionSeed,
  'externalId' | 'content' | 'type'
>;

export function builtinQuestionIdentity(q: BuiltinQuestionIdentityInput): string {
  const externalId = q.externalId?.trim();
  if (externalId) return `external:${externalId}`;
  return `content:${q.type}:${q.content}`;
}

export function findMissingBuiltinQuestions(
  desired: BuiltinQuestionSeed[],
  existing: BuiltinQuestionIdentityInput[],
): BuiltinQuestionSeed[] {
  const existingKeys = new Set(existing.map(builtinQuestionIdentity));
  return desired.filter((q) => !existingKeys.has(builtinQuestionIdentity(q)));
}

/**
 * 把内置样本集构建为可落库的题集种子（纯函数，不触库）。
 * @param sampleId 样本集 ID，默认 lse-safety-mini。
 * @throws 当 sampleId 不存在时抛出「未知的内置样本集」。
 */
export function buildBuiltinQuestionSetSeed(
  sampleId: string = BUILTIN_SAMPLE_ID,
): BuiltinQuestionSetSeed {
  const meta = getBenchmarkSample(sampleId);
  if (!meta) {
    throw new Error(`未知的内置样本集：${sampleId}`);
  }
  const parsed = loadBenchmarkSample(sampleId);
  return {
    source: `benchmark:${sampleId}`,
    name: meta.label,
    description: meta.description,
    type: 'GENERAL',
    tags: ['内置', '开箱即用'],
    isBuiltin: true,
    questions: parsed.items.map((it) => ({
      externalId: it.externalId,
      content: it.content,
      category: it.category,
      expectedBehavior: it.expectedBehavior,
      referenceAnswer: it.referenceAnswer,
      type: it.type,
      severity: it.severity,
      shouldRefuse: it.shouldRefuse,
      language: 'zh',
      tags: it.tags,
    })),
  };
}
