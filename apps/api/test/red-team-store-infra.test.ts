import { test } from 'node:test';
import assert from 'node:assert/strict';
import { persistPair } from '../src/modules/red-team/store.js';

// 复用与本文件既有的 fakeStore 形态（见 red-team-store.test.ts）。
function fakeStore() {
  const evalResults: any[] = [];
  const engineRuns: any[] = [];
  const findings: any[] = [];
  return {
    evalResults,
    engineRuns,
    findings,
    async createEvalResult(d: any) {
      const r = { id: `er${evalResults.length + 1}`, ...d };
      evalResults.push(r);
      return r;
    },
    async createEngineRun(d: any) {
      engineRuns.push(d);
    },
    async createFindings(rows: any[]) {
      findings.push(...rows);
    },
  };
}

// 基础正常 pair（无 infraIncomplete）：A 侧 FAIL，B 侧 PASS。
function basePair(overrides: any = {}) {
  return {
    controlGroupId: 'cg1',
    recording: {
      seedId: 'q1',
      attackerTurns: [],
      transcript: [],
      movesUsed: ['academic_wrap'],
      rounds: 2,
      stopReason: 'max_round',
      attackerSelfAssessBroken: false,
      brokenLayers: [],
      ...overrides.recording,
    },
    sideA: {
      side: 'A',
      modelTargetId: 'mtA',
      finalPrompt: 'm',
      response: 'r',
      replayMessages: [],
      judge: { verdict: 'FAIL', score: 0.9, riskCategory: 'jail', severity: 'HIGH', evidence: 'e' },
    },
    sideB: {
      side: 'B',
      modelTargetId: 'gw',
      finalPrompt: 'm',
      response: 'r2',
      replayMessages: [],
      judge: {
        verdict: 'PASS',
        score: 0.1,
        riskCategory: 'jail',
        severity: 'HIGH',
        evidence: null,
      },
    },
    ...overrides,
  } as any;
}

test('基础设施未完成(infraIncomplete=true)：EvalResult/EngineRun 落 ERROR，不写 Finding', async () => {
  const store = fakeStore();
  const pair = basePair({
    recording: { infraIncomplete: true, errorType: 'INFRASTRUCTURE_INCOMPLETE' },
  });
  // infraIncomplete 时即使 side.judge.verdict 标了 FAIL 也不应产生 Finding（无真实判定依据）。
  await persistPair(store as any, { taskId: 't1', headName: 'react', seedTitle: 'g' }, pair);
  assert.equal(store.evalResults.length, 2);
  for (const er of store.evalResults) {
    assert.equal(er.status, 'ERROR');
    assert.equal(er.finalVerdict, 'ERROR');
  }
  for (const run of store.engineRuns) {
    assert.equal(run.status, 'ERROR');
  }
  assert.equal(store.findings.length, 0, '基础设施未完成不得产生 Finding');
});

test('配置错误(infraIncomplete=true, errorType=CONFIG_ERROR)：同样落 ERROR 不写 Finding', async () => {
  const store = fakeStore();
  const pair = basePair({ recording: { infraIncomplete: true, errorType: 'CONFIG_ERROR' } });
  await persistPair(store as any, { taskId: 't1', headName: 'react', seedTitle: 'g' }, pair);
  assert.equal(
    store.evalResults.every((e: any) => e.status === 'ERROR'),
    true,
  );
  assert.equal(store.findings.length, 0);
});

test('正常完成(无 infraIncomplete)：保持 SUCCESS，FAIL 侧写 Finding（回归）', async () => {
  const store = fakeStore();
  const pair = basePair(); // 无 infraIncomplete
  await persistPair(store as any, { taskId: 't1', headName: 'react', seedTitle: 'g' }, pair);
  assert.equal(
    store.evalResults.every((e: any) => e.status === 'SUCCESS'),
    true,
  );
  assert.equal(store.evalResults[0].finalVerdict, 'FAIL');
  assert.equal(store.findings.length, 1, 'FAIL 侧正常写 Finding');
});
