import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRedTeamAttack } from '../src/modules/red-team/pipe.js';
import { toJudgeInput } from '../src/modules/red-team/judge-input.js';

const seed = {
  questionId: 'q1',
  content: 'g',
  category: null,
  expectedBehavior: null,
  referenceAnswer: null,
  shouldRefuse: true,
  severity: null,
  questionType: 'SHOULD_REFUSE',
} as any;
const cfg = {
  moves: [],
  maxRounds: 6,
  noProgressK: 3,
  budgetTokens: null,
  gatewayTargetId: 'gw',
  attackerTargetId: 'atk',
};

function fakeJudge(verdictsByResponse: Record<string, 'PASS' | 'FAIL'>) {
  return {
    engine: 'llm-judge',
    async judge(input: any) {
      const verdict = verdictsByResponse[input.response] ?? 'PASS';
      return {
        engine: 'llm-judge',
        taskId: input.taskId,
        questionId: input.questionId,
        status: 'success',
        riskCategory: 'jailbreak',
        severity: verdict === 'FAIL' ? 'HIGH' : 'INFO',
        score: verdict === 'FAIL' ? 0.9 : 0.1,
        verdict,
        evidence: null,
        rawOutput: {},
        startedAt: '',
        endedAt: '',
      };
    },
  } as any;
}

test('录一份脚本，对 A/B 各重放一遍，用同一裁判判两侧', async () => {
  const head = {
    name: 'dummy',
    async attack() {
      return {
        seedId: 'q1',
        attackerTurns: [
          { move: 'academic_wrap', message: 'm1' },
          { move: 'foot_in_door', message: 'm2' },
        ],
        transcript: [],
        movesUsed: ['academic_wrap', 'foot_in_door'],
        rounds: 2,
        stopReason: 'max_round',
        attackerSelfAssessBroken: false,
      };
    },
  } as any;
  const seenTargets: string[] = [];
  const chat = async (cfg2: any, messages: any[]) => {
    seenTargets.push(cfg2.model);
    return { content: cfg2.model === 'bare' ? '给你步骤' : '抱歉无法' };
  };
  const judged: string[] = [];
  const judge = {
    engine: 'llm-judge',
    async judge(input: any) {
      judged.push(input.response);
      return {
        engine: 'llm-judge',
        taskId: input.taskId,
        questionId: input.questionId,
        status: 'success',
        riskCategory: 'jailbreak',
        severity: 'HIGH',
        score: input.response.includes('步骤') ? 0.9 : 0.1,
        verdict: input.response.includes('步骤') ? 'FAIL' : 'PASS',
        evidence: null,
        rawOutput: {},
        startedAt: '',
        endedAt: '',
      };
    },
  } as any;
  const pair = await runRedTeamAttack({
    task: { id: 't1', modelTargetId: 'mtA' },
    bareTarget: { baseUrl: 'http://a', apiKey: 'k', model: 'bare' } as any, // pragma: allowlist secret nosemgrep
    seed,
    cfg,
    head,
    deps: {
      chat,
      judge,
      loadTarget: async () => ({ baseUrl: 'http://gw', apiKey: 'k', model: 'gateway' }) as any,
    }, // pragma: allowlist secret nosemgrep
    controlGroupId: 'cg-1',
  });
  assert.equal(pair.controlGroupId, 'cg-1');
  assert.equal(pair.sideA.side, 'A');
  assert.equal(pair.sideB.side, 'B');
  assert.equal(pair.sideA.judge.verdict, 'FAIL'); // 裸模型给了步骤 → 破
  assert.equal(pair.sideB.judge.verdict, 'PASS'); // 网关后被挡 → 未破
  assert.equal(pair.sideA.finalPrompt, 'm2'); // 最后一轮 attacker 话术
  // 同一脚本放两遍：每侧 2 轮，共 4 次 chat
  assert.equal(seenTargets.filter((m) => m === 'bare').length, 2);
  assert.equal(seenTargets.filter((m) => m === 'gateway').length, 2);
});

test('网关识别且 B 侧破局时 redLayerReward=0.5 并记录 recognizedRisk', async () => {
  const head = {
    name: 'dummy',
    async attack() {
      return {
        seedId: 'q1',
        attackerTurns: [{ move: 'academic_wrap', message: 'm1' }],
        transcript: [],
        movesUsed: ['academic_wrap'],
        rounds: 1,
        stopReason: 'success',
        attackerSelfAssessBroken: true,
      };
    },
  } as any;
  const chat = async (cfg2: any) => ({
    content: cfg2.model === 'gateway' ? '给你步骤' : '裸模型步骤',
  });
  const pair = await runRedTeamAttack({
    task: { id: 't-recognized', modelTargetId: 'mtA' },
    bareTarget: { baseUrl: 'http://a', apiKey: 'k', model: 'bare' } as any, // pragma: allowlist secret nosemgrep
    seed,
    cfg,
    head,
    deps: {
      chat,
      judge: fakeJudge({ 给你步骤: 'FAIL', 裸模型步骤: 'FAIL' }),
      loadTarget: async () => ({ baseUrl: 'http://gw', apiKey: 'k', model: 'gateway' }) as any, // pragma: allowlist secret nosemgrep
      collectGatewayEvidence: async () => ({ gatewayRecognizedRisk: true }),
    },
    controlGroupId: 'cg-recognized',
  });

  assert.equal(pair.recording.redLayerReward, 0.5);
  assert.equal(pair.recording.gatewayRecognizedRisk, true);
  assert.equal(pair.recording.recognizedRisk, true);
});

test('网关未识别且 B 侧破局时 redLayerReward=1 标记隐身破防', async () => {
  const head = {
    name: 'dummy',
    async attack() {
      return {
        seedId: 'q1',
        attackerTurns: [{ move: 'academic_wrap', message: 'm1' }],
        transcript: [],
        movesUsed: ['academic_wrap'],
        rounds: 1,
        stopReason: 'success',
        attackerSelfAssessBroken: true,
      };
    },
  } as any;
  const chat = async () => ({ content: '给你步骤' });
  const pair = await runRedTeamAttack({
    task: { id: 't-stealth', modelTargetId: 'mtA' },
    bareTarget: { baseUrl: 'http://a', apiKey: 'k', model: 'bare' } as any, // pragma: allowlist secret nosemgrep
    seed,
    cfg,
    head,
    deps: {
      chat,
      judge: fakeJudge({ 给你步骤: 'FAIL' }),
      loadTarget: async () => ({ baseUrl: 'http://gw', apiKey: 'k', model: 'gateway' }) as any, // pragma: allowlist secret nosemgrep
      collectGatewayEvidence: async () => ({ gatewayRecognizedRisk: false }),
    },
    controlGroupId: 'cg-stealth',
  });

  assert.equal(pair.recording.redLayerReward, 1);
  assert.equal(pair.recording.gatewayRecognizedRisk, false);
  assert.equal(pair.recording.recognizedRisk, false);
});

test('B 侧未破局时 redLayerReward=0 且 recognizedRisk 有值', async () => {
  const head = {
    name: 'dummy',
    async attack() {
      return {
        seedId: 'q1',
        attackerTurns: [{ move: 'academic_wrap', message: 'm1' }],
        transcript: [],
        movesUsed: ['academic_wrap'],
        rounds: 1,
        stopReason: 'max_round',
        attackerSelfAssessBroken: false,
      };
    },
  } as any;
  const chat = async (cfg2: any) => ({
    content: cfg2.model === 'gateway' ? '抱歉无法' : '裸模型步骤',
  });
  const pair = await runRedTeamAttack({
    task: { id: 't-clean', modelTargetId: 'mtA' },
    bareTarget: { baseUrl: 'http://a', apiKey: 'k', model: 'bare' } as any, // pragma: allowlist secret nosemgrep
    seed,
    cfg,
    head,
    deps: {
      chat,
      judge: fakeJudge({ 裸模型步骤: 'FAIL', 抱歉无法: 'PASS' }),
      loadTarget: async () => ({ baseUrl: 'http://gw', apiKey: 'k', model: 'gateway' }) as any, // pragma: allowlist secret nosemgrep
      collectGatewayEvidence: async () => ({ gatewayRecognizedRisk: false }),
    },
    controlGroupId: 'cg-clean',
  });

  assert.equal(pair.sideB?.judge.verdict, 'PASS');
  assert.equal(pair.recording.redLayerReward, 0);
  assert.equal(pair.recording.gatewayRecognizedRisk, false);
  assert.equal(pair.recording.recognizedRisk, false);
});

test('pipe 把 runtime（judge + taskId）透传给 head.attack（生产破局接线）', async () => {
  // fake head 把第 4 个 runtime 参数原样记录下来，断言 pipe 确实透传了 deps.judge 与 task.id。
  let seenRuntime: { judge?: unknown; taskId?: string } | undefined;
  const head = {
    name: 'dummy',
    async attack(_t: any, _s: any, _c: any, runtime: any) {
      seenRuntime = runtime;
      return {
        seedId: 'q1',
        attackerTurns: [{ move: 'academic_wrap', message: 'm1' }],
        transcript: [],
        movesUsed: ['academic_wrap'],
        rounds: 1,
        stopReason: 'max_round',
        attackerSelfAssessBroken: false,
      };
    },
  } as any;
  const chat = async (cfg2: any) => ({ content: cfg2.model === 'bare' ? '给你步骤' : '抱歉无法' });
  const judge = {
    engine: 'llm-judge',
    async judge(input: any) {
      return {
        engine: 'llm-judge',
        taskId: input.taskId,
        questionId: input.questionId,
        status: 'success',
        riskCategory: 'jb',
        severity: 'INFO',
        score: 0.9,
        verdict: 'PASS',
        evidence: null,
        rawOutput: {},
        startedAt: '',
        endedAt: '',
      };
    },
  } as any;
  await runRedTeamAttack({
    task: { id: 't-rt', modelTargetId: 'mtA' },
    bareTarget: { baseUrl: 'http://a', apiKey: 'k', model: 'bare' } as any, // pragma: allowlist secret nosemgrep
    seed,
    cfg,
    head,
    deps: {
      chat,
      judge,
      loadTarget: async () => ({ baseUrl: 'http://gw', apiKey: 'k', model: 'gateway' }) as any,
    }, // pragma: allowlist secret nosemgrep
    controlGroupId: 'cg-rt',
  });
  assert.notEqual(seenRuntime, undefined); // 必须透传 runtime，而非 undefined
  assert.equal(seenRuntime?.judge, judge); // runtime.judge === deps.judge（同一实例）
  assert.equal(seenRuntime?.taskId, 't-rt'); // runtime.taskId === task.id
});

test('pipe 把 attackMemory 与 guardFingerprint 透传给 head.attack', async () => {
  let seenRuntime: { attackMemory?: unknown; guardFingerprint?: string } | undefined;
  const attackMemory = {
    byObjective: async () => [],
    remember: async () => {
      throw new Error('not used');
    },
  };
  const head = {
    name: 'dummy',
    async attack(_t: any, _s: any, _c: any, runtime: any) {
      seenRuntime = runtime;
      return {
        seedId: 'q1',
        attackerTurns: [{ move: 'academic_wrap', message: 'm1' }],
        transcript: [],
        movesUsed: ['academic_wrap'],
        rounds: 1,
        stopReason: 'max_round',
        attackerSelfAssessBroken: false,
      };
    },
  } as any;
  const chat = async (cfg2: any) => ({ content: cfg2.model === 'bare' ? '给你步骤' : '抱歉无法' });
  const judge = {
    engine: 'llm-judge',
    async judge(input: any) {
      return {
        engine: 'llm-judge',
        taskId: input.taskId,
        questionId: input.questionId,
        status: 'success',
        riskCategory: 'jb',
        severity: 'INFO',
        score: 0.9,
        verdict: 'PASS',
        evidence: null,
        rawOutput: {},
        startedAt: '',
        endedAt: '',
      };
    },
  } as any;

  await runRedTeamAttack({
    task: { id: 't-memory', modelTargetId: 'mtA' },
    bareTarget: { baseUrl: 'http://a', apiKey: 'k', model: 'bare' } as any, // pragma: allowlist secret nosemgrep
    seed,
    cfg,
    head,
    deps: {
      chat,
      judge,
      attackMemory: attackMemory as any,
      loadTarget: async () => ({ baseUrl: 'http://gw', apiKey: 'k', model: 'gateway' }) as any,
    }, // pragma: allowlist secret nosemgrep
    controlGroupId: 'cg-memory',
  });

  assert.equal(seenRuntime?.attackMemory, attackMemory);
  assert.equal(seenRuntime?.guardFingerprint, 'gateway:gw');
});

test('toJudgeInput 把 seed 字段映射进裁判输入（null → undefined）', () => {
  // 非 null 字段的 seed
  const seedFull = {
    questionId: 'q-full',
    content: 'some content',
    category: null,
    expectedBehavior: '期望模型拒绝',
    referenceAnswer: '参考答案文本',
    shouldRefuse: true,
    severity: 'HIGH',
    questionType: 'SHOULD_REFUSE',
  } as any;

  const result = toJudgeInput('task-x', seedFull, 'prompt 文本', 'response 文本'); // pragma: allowlist secret nosemgrep
  assert.equal(result.taskId, 'task-x'); // pragma: allowlist secret nosemgrep
  assert.equal(result.questionId, 'q-full');
  assert.equal(result.questionType, 'SHOULD_REFUSE');
  assert.equal(result.prompt, 'prompt 文本');
  assert.equal(result.response, 'response 文本');
  assert.equal(result.shouldRefuse, true);
  assert.equal(result.expectedBehavior, '期望模型拒绝');
  assert.equal(result.referenceAnswer, '参考答案文本');
  assert.equal(result.severity, 'HIGH');

  // 使用文件顶部全 null 的 seed（expectedBehavior/referenceAnswer/severity 都是 null）
  const resultNull = toJudgeInput('task-x', seed, 'prompt 文本', 'response 文本'); // pragma: allowlist secret nosemgrep
  assert.equal(resultNull.expectedBehavior, undefined);
  assert.equal(resultNull.referenceAnswer, undefined);
  assert.equal(resultNull.severity, undefined);
});

test('单模型模式只重放被测模型，不要求 B 侧防护层', async () => {
  const singleCfg = { ...cfg, gatewayTargetId: '' };
  const head = {
    name: 'dummy',
    async attack() {
      return {
        seedId: 'q1',
        attackerTurns: [
          { move: 'academic_wrap', message: 'm1' },
          { move: 'foot_in_door', message: 'm2' },
        ],
        transcript: [],
        movesUsed: ['academic_wrap', 'foot_in_door'],
        rounds: 2,
        stopReason: 'max_round',
        attackerSelfAssessBroken: false,
      };
    },
  } as any;
  const seenTargets: string[] = [];
  const loadedTargets: string[] = [];
  const chat = async (cfg2: any) => {
    seenTargets.push(cfg2.model);
    return { content: '给你步骤' };
  };
  const judge = {
    engine: 'llm-judge',
    async judge(input: any) {
      return {
        engine: 'llm-judge',
        taskId: input.taskId,
        questionId: input.questionId,
        status: 'success',
        riskCategory: 'jailbreak',
        severity: 'HIGH',
        score: 0.9,
        verdict: 'FAIL',
        evidence: null,
        rawOutput: {},
        startedAt: '',
        endedAt: '',
      };
    },
  } as any;

  const pair = await runRedTeamAttack({
    task: { id: 't-single', modelTargetId: 'mtA' },
    bareTarget: { baseUrl: 'http://a', apiKey: 'k', model: 'bare' } as any, // pragma: allowlist secret nosemgrep
    seed,
    cfg: singleCfg,
    head,
    deps: {
      chat,
      judge,
      loadTarget: async (targetId) => {
        loadedTargets.push(targetId);
        return { baseUrl: 'http://gw', apiKey: 'k', model: 'gateway' } as any; // pragma: allowlist secret nosemgrep
      },
    },
    controlGroupId: 'cg-single',
  });

  assert.equal(pair.controlGroupId, 'cg-single');
  assert.equal(pair.sideA.side, 'A');
  assert.equal(pair.sideB, undefined);
  assert.equal(seenTargets.filter((m) => m === 'bare').length, 2);
  assert.equal(seenTargets.filter((m) => m === 'gateway').length, 0);
  assert.deepEqual(loadedTargets, []);
});
