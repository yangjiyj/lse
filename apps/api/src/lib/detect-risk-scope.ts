import type { Prisma } from '@prisma/client';

/** 评估风险项：有严重度、没被人工判为误报、判定不是通过（终端体检只算不通过）。 */
export const ACTIVE_EVAL_FINDING: Prisma.FindingWhereInput = {
  severity: { not: null },
  reviewStatus: { not: 'FALSE_POSITIVE' },
  verdict: { not: 'PASS' },
};

/** 模型文件扫描发现：没被判为误报。 */
export const ACTIVE_MODEL_FILE_FINDING: Prisma.ModelFileFindingWhereInput = {
  reviewStatus: { not: 'FALSE_POSITIVE' },
};

/** 语料命中：裁判复核没判为误报（judgeVerdict 为空的也算；SQL 里 NULL <> 'DISMISSED' 不成立，必须写 OR）。 */
export const ACTIVE_CORPUS_FINDING: Prisma.CorpusFindingWhereInput = {
  OR: [{ judgeVerdict: null }, { judgeVerdict: { not: 'DISMISSED' } }],
};

/** 组件扫描发现：没被判为误报。 */
export const ACTIVE_AI_COMPONENT_FINDING: Prisma.AiComponentFindingWhereInput = {
  reviewStatus: { not: 'FALSE_POSITIVE' },
};

/**
 * 服务核验的漏洞和基线问题，与首页「AI 应用组件安全」卡片同口径（dashboard/component-security.ts）：
 * 影响状态为受影响或待核验，且有漏洞编号，或者是配置匹配类的基线问题。
 */
export const OPEN_VULNERABILITY_ASSESSMENT: Prisma.VulnerabilityAssessmentWhereInput = {
  impactStatus: { in: ['AFFECTED', 'UNDER_INVESTIGATION'] },
  OR: [{ advisoryId: { not: null } }, { evidenceLevel: 'CONFIG_MATCH' }],
};
