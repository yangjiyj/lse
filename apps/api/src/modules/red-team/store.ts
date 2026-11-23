import type { RedTeamPairResult, RedTeamSideResult } from './types.js';
import {
  prismaAttackMemoryStore,
  shouldRememberAttack,
  type AttackMemoryStore,
} from './attack-memory.js';

export interface RedTeamStore {
  createEvalResult(data: Record<string, unknown>): Promise<{ id: string }>;
  createEngineRun(data: Record<string, unknown>): Promise<void>;
  createFindings(rows: Record<string, unknown>[]): Promise<void>;
  attackMemory?: AttackMemoryStore;
}

export interface RedTeamStoreCtx {
  taskId: string;
  headName: string;
  seedTitle: string;
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

async function persistSide(
  store: RedTeamStore,
  ctx: RedTeamStoreCtx,
  pair: RedTeamPairResult,
  side: RedTeamSideResult,
) {
  // 基础设施未完成（重试+延后重排耗尽、或配置错误）：落 ERROR，绝不冒充 SUCCESS，
  // 也不产生 Finding（无真实判定依据）。spec：这种结果不算 PASS/FAIL/安全风险。
  const infraIncomplete = pair.recording.infraIncomplete === true;
  const resultStatus = infraIncomplete ? 'ERROR' : 'SUCCESS';
  const finalVerdict = infraIncomplete ? 'ERROR' : side.judge.verdict;
  const er = await store.createEvalResult({
    taskId: ctx.taskId,
    questionId: pair.recording.seedId,
    modelTargetId: side.modelTargetId,
    prompt: side.finalPrompt,
    response: side.response,
    status: resultStatus,
    finalVerdict,
    finalScore: side.judge.score,
    controlGroupId: pair.controlGroupId,
    side: side.side,
  });
  await store.createEngineRun({
    taskId: ctx.taskId,
    resultId: er.id,
    engine: 'autonomous-red-team',
    status: resultStatus,
    requestPayload: compactRecord({
      side: side.side,
      headName: ctx.headName,
      movesUsed: pair.recording.movesUsed,
      rounds: pair.recording.rounds,
      stopReason: pair.recording.stopReason,
      brokenLayers: pair.recording.brokenLayers,
      lengthTruncations: pair.recording.lengthTruncations,
      redLayerReward: pair.recording.redLayerReward,
      recognizedRisk: pair.recording.recognizedRisk,
      gatewayRecognizedRisk: pair.recording.gatewayRecognizedRisk,
      playbookVariant: pair.recording.playbook?.variant,
      playbookLabel: pair.recording.playbook?.label,
      playbookObjective: pair.recording.playbook?.objectiveId,
      seedPack: pair.recording.playbook?.seedPack,
      infraIncomplete,
      errorType: pair.recording.errorType ?? null,
    }),
    rawOutput: JSON.stringify({
      recording: pair.recording,
      transcript: pair.recording.transcript,
      replayMessages: side.replayMessages,
      playbook: pair.recording.playbook,
      brokenLayers: pair.recording.brokenLayers,
      redLayerReward: pair.recording.redLayerReward,
      recognizedRisk: pair.recording.recognizedRisk,
      gatewayRecognizedRisk: pair.recording.gatewayRecognizedRisk,
      canaryHit: pair.recording.canaryHit ?? false,
      canaryToken: pair.recording.canaryToken,
    }),
    normalizedCount: 1,
  });
  if (!infraIncomplete && side.judge.verdict === 'FAIL') {
    await store.createFindings([
      {
        taskId: ctx.taskId,
        resultId: er.id,
        questionId: pair.recording.seedId,
        engine: 'autonomous-red-team',
        riskCategory: side.judge.riskCategory,
        severity: side.judge.severity,
        score: side.judge.score,
        verdict: 'FAIL',
        confidence: side.judge.confidence ?? null,
        title: `红队越狱(${side.side}侧): ${ctx.seedTitle}`,
        evidence: side.judge.evidence,
        detail: compactRecord({
          side: side.side,
          controlGroupId: pair.controlGroupId,
          movesUsed: pair.recording.movesUsed,
          rounds: pair.recording.rounds,
          stopReason: pair.recording.stopReason,
          playbookVariant: pair.recording.playbook?.variant,
          playbookLabel: pair.recording.playbook?.label,
          playbookObjective: pair.recording.playbook?.objectiveId,
          seedPack: pair.recording.playbook?.seedPack,
          playbookPhases: pair.recording.playbook?.phases,
          brokenLayers: pair.recording.brokenLayers,
          redLayerReward: pair.recording.redLayerReward,
          recognizedRisk: pair.recording.recognizedRisk,
          gatewayRecognizedRisk: pair.recording.gatewayRecognizedRisk,
          canaryHit: pair.recording.canaryHit ?? false,
          canaryToken: pair.recording.canaryToken,
          attitudePath: pair.recording.transcript.map((t) => t.attitude),
        }),
      },
    ]);
  }
}

export async function persistPair(
  store: RedTeamStore,
  ctx: RedTeamStoreCtx,
  pair: RedTeamPairResult,
): Promise<void> {
  await persistSide(store, ctx, pair, pair.sideA);
  if (pair.sideB) {
    await persistSide(store, ctx, pair, pair.sideB);
  }
  await rememberPairAttack(store, pair);
}

/**
 * 生产落库实现：直接打到 Prisma。create-only（不更新、不删除），与本特性的只追加约定一致。
 * 仅 FAIL 侧写 Finding（由 persistPair 决定调用与否）。
 */
export function redTeamPrismaStore(prisma: any, _taskId: string): RedTeamStore {
  return {
    createEvalResult: (data) => prisma.evalResult.create({ data, select: { id: true } }),
    createEngineRun: async (data) => {
      await prisma.engineRun.create({ data });
    },
    createFindings: async (rows) => {
      if (rows.length) await prisma.finding.createMany({ data: rows });
    },
    attackMemory: prismaAttackMemoryStore(prisma),
  };
}

async function rememberPairAttack(store: RedTeamStore, pair: RedTeamPairResult): Promise<void> {
  if (!store.attackMemory) return;
  const judgedSide = pair.sideB ?? pair.sideA;
  const objectiveId = pair.recording.playbook?.objectiveId;
  const reward = pair.recording.redLayerReward;
  if (
    !shouldRememberAttack({
      broke: judgedSide.judge.verdict === 'FAIL',
      verdict: judgedSide.judge.verdict,
      redLayerReward: reward,
      executionNoise: judgedSide.judge.verdict === 'ERROR',
      objectiveId,
    })
  ) {
    return;
  }

  await store.attackMemory.remember({
    objectiveId: objectiveId!,
    guardFingerprint: pair.sideB ? `gateway:${pair.sideB.modelTargetId}` : 'bare',
    playbookVariant: pair.recording.playbook?.variant ?? 'unknown',
    moveSequence: pair.recording.movesUsed,
    brokenLayers: pair.recording.brokenLayers ?? [],
    redLayerReward: reward!,
    ts: new Date(),
  });
}
