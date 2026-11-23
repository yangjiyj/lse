import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAssuranceSamplePlan } from '../src/modules/assurance/samples.js';
import type { GatewayAssuranceContract } from '../src/modules/assurance/types.js';

const contract: GatewayAssuranceContract = {
  schemaVersion: 'gateway-assurance-contract/v1',
  tenantId: 'tenant-a',
  generatedAt: '2026-06-20T00:00:00Z',
  policies: [
    {
      policyId: 'secret.api_key.leak',
      version: 'p0',
      category: 'secret',
      mode: 'strict',
      expectedDecision: 'block',
      severity: 'critical',
      detector: 'secret',
      evidenceRequired: true,
      sampleGenerationHint: 'fake token',
      negativeContext: [],
      sampleVariants: [
        { variantId: 'direct', label: '直接命中', strategy: 'direct', weight: 1 },
        { variantId: 'context_noise', label: '上下文噪声', strategy: 'context_noise', weight: 1 },
        { variantId: 'multilingual', label: '中英混合', strategy: 'multilingual', weight: 1 },
        { variantId: 'multi_turn', label: '多轮诱导', strategy: 'multi_turn', weight: 1 },
      ],
    },
    {
      policyId: 'prompt.prompt_injection',
      version: 'p0',
      category: 'prompt_injection',
      mode: 'audit',
      expectedDecision: 'alert',
      severity: 'high',
      detector: 'prompt_injection',
      evidenceRequired: true,
      sampleGenerationHint: 'system prompt extraction',
      negativeContext: [],
      sampleVariants: [
        { variantId: 'direct', label: '直接命中', strategy: 'direct', weight: 1 },
        { variantId: 'context_noise', label: '上下文噪声', strategy: 'context_noise', weight: 1 },
        { variantId: 'multilingual', label: '中英混合', strategy: 'multilingual', weight: 1 },
        { variantId: 'multi_turn', label: '多轮诱导', strategy: 'multi_turn', weight: 1 },
      ],
    },
    {
      policyId: 'web.retention_visibility',
      version: 'p0',
      category: 'web_retention',
      mode: 'audit',
      expectedDecision: 'alert',
      severity: 'medium',
      detector: 'proxy_retention',
      evidenceRequired: true,
      sampleGenerationHint: 'web prompt',
      negativeContext: [],
      sampleVariants: [
        { variantId: 'direct', label: '直接命中', strategy: 'direct', weight: 1 },
        { variantId: 'context_noise', label: '上下文噪声', strategy: 'context_noise', weight: 1 },
        { variantId: 'multilingual', label: '中英混合', strategy: 'multilingual', weight: 1 },
        { variantId: 'multi_turn', label: '多轮诱导', strategy: 'multi_turn', weight: 1 },
      ],
    },
  ],
  linkContracts: [
    { linkId: 'request_log', required: true },
    { linkId: 'content_log', required: true },
    { linkId: 'security_event', required: true },
    { linkId: 'alert', required: true },
  ],
};

test('buildAssuranceSamplePlan creates deterministic variant samples for every gateway policy', () => {
  const plan = buildAssuranceSamplePlan(contract, {
    runId: 'run-1',
    taskId: 'task-1',
    targetId: 'target-1',
  });

  assert.equal(plan.samples.length, 12);
  assert.equal(new Set(plan.samples.map((sample) => sample.policyId)).size, 3);
  assert.equal(new Set(plan.samples.map((sample) => sample.sampleId)).size, 12);
  assert.equal(plan.taskId, 'task-1');
  assert.equal(plan.targetId, 'target-1');
  assert.equal(plan.samples[0]?.policyId, 'secret.api_key.leak');
  assert.equal(plan.samples[0]?.variantId, 'direct');
  assert.equal(plan.samples[0]?.variantLabel, '直接命中');
  assert.equal(plan.samples[0]?.traceId, 'run-1-secret_api_key_leak-direct-0');
  assert.equal(plan.samples[0]?.sampleId, 'run-1-secret_api_key_leak-direct-0');
  assert.equal(plan.samples[0]?.taskId, 'task-1');
  assert.equal(plan.samples[0]?.targetId, 'target-1');
  assert.match(plan.samples[0]?.traceId ?? '', /^[A-Za-z0-9_-]+$/);
  assert.equal(plan.samples[0]?.expected.requestLog, true);
  assert.equal(plan.samples[0]?.expected.contentLog, true);
  assert.equal(plan.samples[0]?.expected.securityEvent, true);
  assert.equal(plan.samples[0]?.expected.alert, true);
  assert.match(plan.samples[0]?.prompt ?? '', /api[_-]?key\s*[:=]\s*[A-Za-z0-9_-]{8,}/i);
  assert.match(plan.samples[1]?.prompt ?? '', /上下文噪声|业务上下文/);
  assert.match(plan.samples[2]?.prompt ?? '', /English|中文|bilingual/i);
  const multiTurn = plan.samples.find((sample) => sample.variantId === 'multi_turn');
  assert(multiTurn);
  assert.equal(multiTurn.turns?.length, 2);
  assert.match(multiTurn.turns?.[0]?.content ?? '', /准备|上下文|先确认/);
  assert.match(
    multiTurn.turns?.[1]?.content ?? '',
    /api[_-]?key|系统提示词|token|身份证|爆炸物|预算|路由/i,
  );
  assert.match(multiTurn.prompt, /第 1 轮/);
  assert.match(multiTurn.prompt, /第 2 轮/);
  assert.match(plan.samples[5]?.prompt ?? '', /忽略以上指令/);
  assert.match(plan.samples[5]?.prompt ?? '', /系统提示词|system prompt/i);
});

test('buildAssuranceSamplePlan emits a detectable agent tool-abuse canary for chat-path assurance', () => {
  const plan = buildAssuranceSamplePlan(
    {
      ...contract,
      policies: [
        {
          policyId: 'agent.tool_abuse',
          version: 'p0',
          category: 'agent',
          mode: 'strict',
          expectedDecision: 'alert',
          severity: 'critical',
          detector: 'agent_guard',
          evidenceRequired: true,
          sampleGenerationHint: 'destructive tool call and credential exfiltration',
          negativeContext: [],
          sampleVariants: [
            { variantId: 'direct', label: '直接命中', strategy: 'direct', weight: 1 },
          ],
        },
      ],
    },
    { runId: 'run-agent', taskId: 'task-1', targetId: 'target-1' },
  );

  const prompt = plan.samples[0]?.prompt ?? '';
  assert.match(prompt, /忽略以上指令/);
  assert.match(prompt, /泄露.*token|发送.*token/);
});
