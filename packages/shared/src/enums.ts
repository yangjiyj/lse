// 与 Prisma schema 枚举保持一致的字符串字面量联合类型（业务层统一引用此处）。
export const SEVERITY = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITY)[number];

export const EVAL_TASK_STATUS = [
  'PENDING',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'CANCELED',
] as const;
export type EvalTaskStatus = (typeof EVAL_TASK_STATUS)[number];

export const ENGINE_RUN_STATUS = [
  'PENDING',
  'RUNNING',
  'SUCCESS',
  'FAILED',
  'ERROR',
  'SKIPPED',
] as const;
export type EngineRunStatus = (typeof ENGINE_RUN_STATUS)[number];

export const FINDING_REVIEW_STATUS = [
  'UNREVIEWED',
  'NEEDS_REVIEW',
  'CONFIRMED',
  'FALSE_POSITIVE',
  'ACCEPTED_RISK',
] as const;
export type FindingReviewStatus = (typeof FINDING_REVIEW_STATUS)[number];

/** 证据强度与风险定性解耦：文本命中不等于工具已执行。 */
export const EVIDENCE_STRENGTH = [
  'CONTROLLED_EXECUTION',
  'TOOL_CALL_ATTEMPT',
  'CUSTOMER_BLOCKED',
  'SANDBOX_BLOCKED',
  'TEXT_OBSERVED',
  'INFERRED',
  'NO_EVIDENCE',
] as const;
export type EvidenceStrength = (typeof EVIDENCE_STRENGTH)[number];

/** 工具调用的实际执行结果，与风险严重性、证据强度分别展示。 */
export const EXECUTION_OUTCOME = [
  'EXECUTED',
  'CUSTOMER_BLOCKED',
  'SANDBOX_BLOCKED',
  'NOT_ATTEMPTED',
  'UNKNOWN',
] as const;
export type ExecutionOutcome = (typeof EXECUTION_OUTCOME)[number];

export const MODEL_CALL_STATUS = ['SUCCESS', 'ERROR'] as const;
export type ModelCallStatus = (typeof MODEL_CALL_STATUS)[number];

export const VERDICT = ['PASS', 'FAIL', 'UNKNOWN', 'ERROR'] as const;
export type Verdict = (typeof VERDICT)[number];

export const QUESTION_TYPE = [
  'COMPLIANCE',
  'PROMPT_INJECTION',
  'SHOULD_REFUSE',
  'GENERAL',
] as const;
export type QuestionType = (typeof QUESTION_TYPE)[number];

export const IMPORT_STATUS = ['PENDING', 'SUCCESS', 'PARTIAL', 'FAILED'] as const;
export type ImportStatus = (typeof IMPORT_STATUS)[number];

export const LICENSE_STATUS = ['ACTIVE', 'EXPIRED', 'INVALID', 'REVOKED'] as const;
export type LicenseStatus = (typeof LICENSE_STATUS)[number];

export const TARGET_TYPE = [
  'MODEL',
  'AGENT',
  'AGENT_API',
  'PLATFORM_APP',
  'ENDPOINT_AGENT',
  'PUBLIC_AGENT',
  'MCP_OPENAPI',
  'GATEWAY_LOG',
  'JUDGE',
] as const;
export type TargetType = (typeof TARGET_TYPE)[number];

export const LANGUAGE = [
  'zh',
  'en',
  'ja',
  'ko',
  'es',
  'fr',
  'de',
  'ru',
  'ar',
  'hi',
  'pt',
  'vi',
  'th',
  'tr',
  'id',
  'bn',
  'ur',
  'fa',
  'sw',
  'ha',
  'yo',
  'ta',
  'te',
  'ml',
  'my',
  'km',
  'lo',
  'fil',
  'ms',
  'he',
  'el',
  'pl',
  'uk',
  'cs',
  'ro',
  'hu',
  'fi',
  'sv',
  'lt',
  'et',
  'ka',
  'hy',
  'kk',
  'uz',
  'mn',
  'bo',
] as const;
export type Language = (typeof LANGUAGE)[number];
export const DEFAULT_LANGUAGE: Language = 'zh';
