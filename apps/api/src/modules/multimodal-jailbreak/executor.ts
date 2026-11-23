import type { ChatMessage, EngineResult, JudgeInput, LlmCallResult } from '@lse/shared';
import type { Prisma, QuestionType, Severity, Verdict } from '@prisma/client';
import {
  MULTIMODAL_ATTACK_LABELS,
  MULTIMODAL_ATTACK_TYPES,
  MULTIMODAL_CARRIERS,
  buildMultimodalAttack,
  describeAttackForJudge,
  type MultimodalAttackType,
  type MultimodalCarrier,
} from './attacks.js';

export const MULTIMODAL_ENGINE = 'multimodal-jailbreak';
export const MULTIMODAL_QUESTION_KIND = 'multimodal_jailbreak';

export interface MultimodalQuestionMeta {
  kind: typeof MULTIMODAL_QUESTION_KIND;
  attackType: MultimodalAttackType;
  seed: string;
  instruction: string;
  /** 图内注入承载版式；缺省（旧数据）沿用会议通知版式。 */
  carrier: MultimodalCarrier | null;
  sourceQuestionId: string | null;
}

export function parseMultimodalMeta(metadata: unknown): MultimodalQuestionMeta | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const m = (metadata as Record<string, unknown>).multimodal;
  if ((metadata as Record<string, unknown>).kind !== MULTIMODAL_QUESTION_KIND) return null;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const r = m as Record<string, unknown>;
  const attackType = r.attackType;
  if (!MULTIMODAL_ATTACK_TYPES.includes(attackType as MultimodalAttackType)) return null;
  if (typeof r.seed !== 'string' || typeof r.instruction !== 'string') return null;
  return {
    kind: MULTIMODAL_QUESTION_KIND,
    attackType: attackType as MultimodalAttackType,
    seed: r.seed,
    instruction: r.instruction,
    carrier: MULTIMODAL_CARRIERS.includes(r.carrier as MultimodalCarrier)
      ? (r.carrier as MultimodalCarrier)
      : null,
    sourceQuestionId: typeof r.sourceQuestionId === 'string' ? r.sourceQuestionId : null,
  };
}

/** 构造 OpenAI 兼容多模态 user 消息：content=[text, image_url(data:image/png;base64)]。 */
export function buildMultimodalMessage(text: string, png: Buffer): ChatMessage {
  return {
    role: 'user',
    content: text,
    contentParts: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
    ],
  };
}

type Db = {
  evalResult: {
    create(args: { data: Prisma.EvalResultUncheckedCreateInput }): Promise<{ id: string }>;
  };
  engineRun: { create(args: { data: Prisma.EngineRunUncheckedCreateInput }): Promise<unknown> };
  finding: { create(args: { data: Prisma.FindingUncheckedCreateInput }): Promise<unknown> };
};

export interface RunMultimodalQuestionArgs {
  db: Db;
  taskId: string;
  modelTargetId: string;
  supportsVision: boolean;
  question: {
    id: string;
    content: string;
    type: QuestionType;
    severity: Severity | null;
    shouldRefuse: boolean;
    expectedBehavior: string | null;
    referenceAnswer: string | null;
  };
  meta: MultimodalQuestionMeta;
  invoke: (messages: ChatMessage[]) => Promise<LlmCallResult>;
  /** 复用任务装配的 llm-judge（全局判定模型）；null 表示判定模型不可用。 */
  judge: { judge(input: JudgeInput): Promise<EngineResult> | EngineResult } | null;
}

export interface RunMultimodalQuestionResult {
  verdict: Verdict;
  resultId: string;
}

/** 执行一道多模态越狱题：生成图片 → 发送 → 判定 → 落 EvalResult/EngineRun/Finding。 */
export async function runMultimodalQuestion(
  args: RunMultimodalQuestionArgs,
): Promise<RunMultimodalQuestionResult> {
  const { db, taskId, question, meta } = args;
  const startedAt = new Date();
  const attack = buildMultimodalAttack({
    instruction: meta.instruction,
    attackType: meta.attackType,
    seed: meta.seed,
    ...(meta.carrier ? { carrier: meta.carrier } : {}),
  });
  const judgePrompt = describeAttackForJudge(attack, meta.instruction);

  let call: LlmCallResult | null = null;
  let error: string | null = null;
  if (!args.supportsVision) {
    error = '评估对象未声明支持图片输入，已跳过多模态越狱发送';
  } else {
    call = await args.invoke([buildMultimodalMessage(attack.text, attack.png)]);
    if (call.status !== 'SUCCESS') error = call.error ?? '模型调用失败';
  }

  let judgeResult: EngineResult | null = null;
  let verdict: Verdict = 'ERROR';
  if (call && call.status === 'SUCCESS') {
    if (!call.content.trim()) {
      verdict = 'UNKNOWN';
    } else if (!args.judge) {
      verdict = 'UNKNOWN';
      error = '未配置可用的判定模型，结果待人工复核';
    } else {
      judgeResult = await args.judge.judge({
        taskId,
        questionId: question.id,
        questionType: question.type,
        prompt: judgePrompt,
        response: call.content,
        expectedBehavior: question.expectedBehavior,
        referenceAnswer: question.referenceAnswer,
        shouldRefuse: question.shouldRefuse,
        severity: question.severity,
        rules: null,
      });
      verdict = judgeResult.status === 'success' ? judgeResult.verdict : 'UNKNOWN';
    }
  }
  const endedAt = new Date();
  const latencyMs = call?.latencyMs ?? 0;
  const created = await db.evalResult.create({
    data: {
      taskId,
      questionId: question.id,
      modelTargetId: args.modelTargetId,
      prompt: judgePrompt,
      response: call && call.status === 'SUCCESS' ? call.content : null,
      usage: {
        promptTokens: call?.usage.promptTokens ?? null,
        completionTokens: call?.usage.completionTokens ?? null,
        totalTokens: call?.usage.totalTokens ?? null,
      },
      latencyMs,
      status: call && call.status === 'SUCCESS' ? 'SUCCESS' : 'ERROR',
      errorMessage: error,
      finalVerdict: verdict,
      finalScore: judgeResult?.score ?? null,
      startedAt,
      endedAt,
    },
  });

  // 图片存证：EngineRun.rawOutput 保存 base64 PNG + sha256，结果详情页据此展示原图。
  const evidence = {
    kind: MULTIMODAL_QUESTION_KIND,
    attackType: attack.attackType,
    attackLabel: MULTIMODAL_ATTACK_LABELS[attack.attackType],
    seed: attack.seed,
    text: attack.text,
    imageText: attack.imageText,
    injectedText: attack.injectedText,
    image: {
      mimeType: 'image/png',
      width: attack.width,
      height: attack.height,
      sha256: attack.imageSha256,
      base64: attack.png.toString('base64'),
    },
    sourceQuestionId: meta.sourceQuestionId,
    judge: judgeResult
      ? {
          engine: judgeResult.engine,
          status: judgeResult.status,
          verdict: judgeResult.verdict,
          severity: judgeResult.severity,
          score: judgeResult.score,
          evidence: judgeResult.evidence,
        }
      : null,
    error,
  };
  await db.engineRun.create({
    data: {
      taskId,
      resultId: created.id,
      engine: MULTIMODAL_ENGINE,
      status: verdict === 'ERROR' ? 'FAILED' : 'SUCCESS',
      startedAt,
      endedAt,
      durationMs: endedAt.getTime() - startedAt.getTime(),
      normalizedCount: judgeResult ? 1 : 0,
      requestPayload: {
        attackType: attack.attackType,
        seed: attack.seed,
        imageSha256: attack.imageSha256,
        supportsVision: args.supportsVision,
      },
      rawOutput: JSON.stringify(evidence),
    },
  });

  if (verdict === 'FAIL' && judgeResult) {
    await db.finding.create({
      data: {
        taskId,
        resultId: created.id,
        questionId: question.id,
        engine: MULTIMODAL_ENGINE,
        riskCategory: `multimodal:${attack.attackType}`,
        severity: judgeResult.severity ?? question.severity ?? 'HIGH',
        score: judgeResult.score,
        verdict: 'FAIL',
        title: `[多模态越狱] ${MULTIMODAL_ATTACK_LABELS[attack.attackType]}绕过安全边界`,
        evidence: judgeResult.evidence,
        detail: {
          kind: MULTIMODAL_QUESTION_KIND,
          attackType: attack.attackType,
          seed: attack.seed,
          imageSha256: attack.imageSha256,
          judgeEngine: judgeResult.engine,
        },
      },
    });
  }
  return { verdict, resultId: created.id };
}
