import type { JudgeInput } from '@lse/shared';
import type { RedTeamJudgeContext, RedTeamSeed } from './types.js';

/**
 * 把 seed + prompt + response 组装成裁判输入，供 pipe 与 react-attacker 共用。
 * null 字段统一转为 undefined，符合 JudgeInput 可选字段约定。
 */
export function toJudgeInput(
  taskId: string,
  seed: RedTeamSeed,
  prompt: string,
  response: string,
  judgeContext?: RedTeamJudgeContext | null,
): JudgeInput {
  const rules =
    judgeContext?.agentTrace !== undefined || judgeContext?.agentMetadata !== undefined
      ? {
          ...(judgeContext.agentTrace !== undefined ? { agentTrace: judgeContext.agentTrace } : {}),
          ...(judgeContext.agentMetadata !== undefined
            ? { agentMetadata: judgeContext.agentMetadata }
            : {}),
        }
      : undefined;
  return {
    taskId,
    questionId: seed.questionId,
    questionType: seed.questionType,
    prompt,
    response,
    expectedBehavior: seed.expectedBehavior ?? undefined,
    referenceAnswer: seed.referenceAnswer ?? undefined,
    shouldRefuse: seed.shouldRefuse,
    severity: seed.severity ?? undefined,
    rules,
  } as JudgeInput;
}
