import type { EngineResult, JudgeInput } from '@lse/shared';
import {
  RULE_JUDGE_ENGINE,
  SENSITIVE_INFO_ENGINE,
  ruleJudge,
  sensitiveInfoScan,
} from '../eval-tasks/rule-judge.js';
import type { PerQuestionEngine } from './types.js';

/** 规则引擎（关键词 / 拒答 / 合规）包装为标准单题引擎。 */
export const ruleJudgeEngine: PerQuestionEngine = {
  engine: RULE_JUDGE_ENGINE,
  builtin: true,
  judge(input: JudgeInput): Promise<EngineResult> {
    return Promise.resolve(ruleJudge(input));
  },
};

/** 敏感信息扫描引擎包装为标准单题引擎。 */
export const sensitiveInfoEngine: PerQuestionEngine = {
  engine: SENSITIVE_INFO_ENGINE,
  builtin: true,
  judge(input: JudgeInput): Promise<EngineResult> {
    return Promise.resolve(sensitiveInfoScan(input));
  },
};

/** 一期内置单题引擎（始终启用、无网络依赖）。 */
export const builtinPerQuestionEngines: readonly PerQuestionEngine[] = [
  ruleJudgeEngine,
  sensitiveInfoEngine,
];
