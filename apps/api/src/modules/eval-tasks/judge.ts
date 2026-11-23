import type { EngineResult, JudgeInput, JudgeRules } from '@lse/shared';
import {
  RULE_JUDGE_ENGINE,
  SENSITIVE_INFO_ENGINE,
  ruleJudge,
  sensitiveInfoScan,
} from './rule-judge.js';

// 重新导出聚合与排序工具，让执行器只需从本编排层引入一处。
export { aggregateVerdict, SEVERITY_RANK, VERDICT_RANK } from './rule-judge.js';

/** 一期内置的纯函数判定引擎（无网络依赖，满足"至少 1 个引擎运行"的验收）。 */
export const BUILTIN_JUDGE_ENGINES = [RULE_JUDGE_ENGINE, SENSITIVE_INFO_ENGINE] as const;

/** 顺序运行全部内置引擎，返回归一化后的 EngineResult 列表。 */
export function runBuiltinJudges(input: JudgeInput): EngineResult[] {
  return [ruleJudge(input), sensitiveInfoScan(input)];
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  }
  if (typeof v === 'string' && v.length > 0) return [v];
  return [];
}

/**
 * 从题目的 metadata（任意 JSON）解析出判定规则，兼容 camelCase 与 snake_case 两种键名，
 * 也兼容单字符串与字符串数组两种写法。无可用规则时返回 null。
 */
export function parseJudgeRules(metadata: unknown): JudgeRules | null {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const m = metadata as Record<string, unknown>;
  const expectedKeywords = toStringArray(m.expectedKeywords ?? m.expected_keywords);
  const forbiddenKeywords = toStringArray(m.forbiddenKeywords ?? m.forbidden_keywords);
  const refusalMarkers = toStringArray(m.refusalMarkers ?? m.refusal_markers);
  const riskIndicators = toStringArray(m.riskIndicators ?? m.risk_indicators);
  const rules: JudgeRules = {};
  if (expectedKeywords.length > 0) rules.expectedKeywords = expectedKeywords;
  if (forbiddenKeywords.length > 0) rules.forbiddenKeywords = forbiddenKeywords;
  if (refusalMarkers.length > 0) rules.refusalMarkers = refusalMarkers;
  if (riskIndicators.length > 0) rules.riskIndicators = riskIndicators;
  return Object.keys(rules).length > 0 ? rules : null;
}
