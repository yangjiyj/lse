import type { EngineResult } from './engine-result.js';
import type { QuestionType, Severity } from './enums.js';

/**
 * 判定规则：从题目 metadata 中解析出的可选关键词约束。
 * - expectedKeywords：期望答案中出现（合规/通用题，命中=通过）
 * - forbiddenKeywords：禁止出现（出现=违规，任何题型都先于其它逻辑判 FAIL）
 * - refusalMarkers：该题特有的拒答标记（叠加在内置中文/英文拒答词之上）
 * - riskIndicators：风险成功信号（出现=疑似违规，用于越狱/工具调用等安全题）
 */
export interface JudgeRules {
  expectedKeywords?: string[];
  forbiddenKeywords?: string[];
  refusalMarkers?: string[];
  riskIndicators?: string[];
  agentTrace?: unknown[];
  agentMetadata?: Record<string, unknown>;
}

/** 单题判定输入：由 executor 从 question + 模型回答组装。 */
export interface JudgeInput {
  taskId: string;
  questionId: string;
  questionType: QuestionType;
  prompt: string;
  response: string;
  expectedBehavior?: string | null;
  referenceAnswer?: string | null;
  shouldRefuse: boolean;
  severity?: Severity | null;
  rules?: JudgeRules | null;
}

/**
 * 判定引擎统一接口。所有内置/外部引擎都把结果归一到 EngineResult，
 * 由 executor 聚合成单题 finalVerdict/finalScore，并落库 Finding/EngineRun。
 */
export interface QuestionJudge {
  readonly engine: string;
  judge(input: JudgeInput): EngineResult | Promise<EngineResult>;
}
