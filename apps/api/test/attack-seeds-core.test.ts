import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LlmCallResult } from '@lse/shared';
import {
  attackSeedSpecSchema,
  generateFromTemplates,
} from '../src/modules/question-sets/attack-seeds/core.js';
import {
  generateAttackSeeds,
  type SeedChatCaller,
} from '../src/modules/question-sets/attack-seeds/llm.js';

const spec = attackSeedSpecSchema.parse({
  domain: '油气管网',
  scope: '调控中心智能客服',
  focus: '调控指令伪造',
  keywords: ['调度令', '压气站'],
  scenarioCount: 3,
  questionsPerScenario: 4,
  binding: { taxonomy: 'energy', categories: ['ENERGY.dispatch_forgery'] },
});
const attacker = { baseUrl: 'https://llm.example.test/v1', apiKey: 'k', model: 'atk' };
const ok = (content: string): LlmCallResult => ({
  status: 'SUCCESS',
  content,
  finishReason: 'stop',
  model: 'atk',
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  latencyMs: 1,
  httpStatus: 200,
  error: null,
  raw: null,
});

test('表单上限：场景≤50、每场景≤50', () => {
  const base = { domain: 'x', scenarioCount: 50, questionsPerScenario: 50 };
  assert.ok(attackSeedSpecSchema.safeParse(base).success);
  assert.ok(!attackSeedSpecSchema.safeParse({ ...base, scenarioCount: 51 }).success);
  assert.ok(!attackSeedSpecSchema.safeParse({ ...base, questionsPerScenario: 51 }).success);
});

test('模板生成：确定性，数量 = 场景 × 每场景题数，绑定分类', () => {
  const a = generateFromTemplates(spec);
  assert.deepEqual(a, generateFromTemplates(spec));
  assert.equal(a.length, 3);
  assert.ok(a.every((s) => s.questions.length === 4 && s.category === 'ENERGY.dispatch_forgery'));
  assert.ok(a[0]!.name.includes('油气管网'));
});

test('未配置攻击模型：回退模板并标明来源', async () => {
  let called = false;
  const call: SeedChatCaller = async () => {
    called = true;
    return ok('{}');
  };
  const r = await generateAttackSeeds(spec, null, call);
  assert.equal(called, false);
  assert.equal(r.source, 'template');
  assert.equal(r.fallbackReason, '未配置主攻击模型');
});

test('攻击模型路径：解析 JSON、裁剪数量、过滤越界分类', async () => {
  const body = {
    scenarios: [
      {
        name: 'S1',
        description: 'd',
        category: 'ENERGY.dispatch_forgery',
        questions: ['q1', 'q2', 'q3', 'q4', 'q5'],
      },
      { name: 'S2', category: 'A.1.a', questions: ['q6'] },
    ],
  };
  const call: SeedChatCaller = async (cfg, messages) => {
    assert.equal(cfg.model, 'atk');
    assert.match(messages[1]!.content, /调控指令伪造/);
    return ok(`以下是结果：\n${JSON.stringify(body)}`);
  };
  const r = await generateAttackSeeds(spec, attacker, call);
  assert.equal(r.source, 'attacker_model');
  assert.equal(r.scenarios.length, 2);
  assert.equal(r.scenarios[0]!.questions.length, 4);
  assert.equal(r.scenarios[1]!.category, null);
});

test('攻击模型失败或返回非 JSON：回退模板', async () => {
  const fail: SeedChatCaller = async () => ({ ...ok(''), status: 'ERROR', error: 'boom' });
  const r1 = await generateAttackSeeds(spec, attacker, fail);
  assert.equal(r1.source, 'template');
  assert.equal(r1.fallbackReason, '攻击模型调用失败');
  const junk: SeedChatCaller = async () => ok('抱歉，我无法完成。');
  const r2 = await generateAttackSeeds(spec, attacker, junk);
  assert.equal(r2.source, 'template');
  assert.equal(r2.scenarios.length, 3);
});
