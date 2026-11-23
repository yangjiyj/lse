// 样本库归类：seed（种子库）/ own（自有样本库）/ run（运行记录）。
// 规则集中在此，列表序列化与列表筛选共用，避免两处口径漂移。
import type { Prisma } from '@prisma/client';

export const QUESTION_SET_KINDS = ['seed', 'own', 'run'] as const;
export type QuestionSetKind = (typeof QUESTION_SET_KINDS)[number];

/** 评估任务运行时自动落库的快照：source 以这些前缀开头。 */
export const RUN_SOURCE_PREFIXES = [
  'red-team',
  'comprehensive:',
  'generator:',
  'agent-runtime:',
  'endpoint-agent-v1',
  'multimodal-jailbreak',
  'custom-risk-fuzz',
  'fanout:',
  'assurance',
  '平台智能体真实观测',
  '验收测试',
] as const;

/** 空 source 的验收/发布验证集：按名称关键字判为运行记录。 */
export const RUN_NAME_KEYWORDS = ['上线验收', '现网发布验证'] as const;

export interface KindInput {
  isBuiltin: boolean;
  source: string | null;
  name?: string | null;
}

export function classifyQuestionSetKind(s: KindInput): QuestionSetKind {
  if (s.isBuiltin) return 'seed';
  const source = s.source?.trim() ?? '';
  if (source) {
    return RUN_SOURCE_PREFIXES.some((p) => source.startsWith(p)) ? 'run' : 'own';
  }
  const name = s.name ?? '';
  return RUN_NAME_KEYWORDS.some((k) => name.includes(k)) ? 'run' : 'own';
}

const emptySource = (): Prisma.QuestionSetWhereInput => ({
  OR: [{ source: null }, { source: '' }],
});
const sourceRun = (): Prisma.QuestionSetWhereInput[] =>
  RUN_SOURCE_PREFIXES.map((p) => ({ source: { startsWith: p } }));
const nameRun = (): Prisma.QuestionSetWhereInput[] =>
  RUN_NAME_KEYWORDS.map((k) => ({ name: { contains: k } }));

/** 与 classifyQuestionSetKind 等价的 Prisma 过滤条件（注意 NOT 对 NULL source 不成立，需显式分支）。 */
export function kindWhere(kind: QuestionSetKind): Prisma.QuestionSetWhereInput {
  if (kind === 'seed') return { isBuiltin: true };
  if (kind === 'run') {
    return {
      isBuiltin: false,
      OR: [...sourceRun(), { AND: [emptySource(), { OR: nameRun() }] }],
    };
  }
  return {
    isBuiltin: false,
    OR: [
      { AND: [{ source: { not: null } }, { source: { not: '' } }, { NOT: { OR: sourceRun() } }] },
      { AND: [emptySource(), { NOT: { OR: nameRun() } }] },
    ],
  };
}
