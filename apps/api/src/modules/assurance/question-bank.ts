import type { AssuranceSamplePlanItem } from './types.js';

const ASSURANCE_QUESTION_SET_SOURCE = 'gateway-assurance';
const ASSURANCE_QUESTION_SET_NAME = '网关 Assurance 自动样本库';

export interface AssuranceQuestionBankClient {
  questionSet: {
    findFirst(args: any): Promise<{ id: string } | null>;
    create(args: any): Promise<{ id: string }>;
  };
  question: {
    findFirst(args: any): Promise<{ id: string } | null>;
    create(args: any): Promise<unknown>;
    update(args: any): Promise<unknown>;
  };
}

export interface AssuranceQuestionBankWritebackResult {
  questionSetId: string;
  created: number;
  updated: number;
}

export async function writeAssuranceSamplesToQuestionBank(
  client: AssuranceQuestionBankClient,
  samples: AssuranceSamplePlanItem[],
): Promise<AssuranceQuestionBankWritebackResult> {
  const set = await ensureAssuranceQuestionSet(client);
  let created = 0;
  let updated = 0;

  for (const sample of samples) {
    const existing = await client.question.findFirst({
      where: { questionSetId: set.id, externalId: sampleExternalId(sample) },
    });
    const data = questionData(set.id, sample);
    if (existing) {
      await client.question.update({ where: { id: existing.id }, data });
      updated += 1;
    } else {
      await client.question.create({ data });
      created += 1;
    }
  }

  return { questionSetId: set.id, created, updated };
}

async function ensureAssuranceQuestionSet(
  client: AssuranceQuestionBankClient,
): Promise<{ id: string }> {
  const existing = await client.questionSet.findFirst({
    where: { source: ASSURANCE_QUESTION_SET_SOURCE },
  });
  if (existing) return existing;
  return client.questionSet.create({
    data: {
      name: ASSURANCE_QUESTION_SET_NAME,
      description:
        '由大模型安全网关 assurance contract 自动生成，用于持续回归网关记录、检测、告警和留证链路。',
      type: 'GENERAL',
      tags: ['assurance', 'gateway', 'auto-generated'],
      source: ASSURANCE_QUESTION_SET_SOURCE,
      isBuiltin: true,
      language: 'zh',
    },
  });
}

function questionData(
  questionSetId: string,
  sample: AssuranceSamplePlanItem,
): Record<string, unknown> {
  return {
    questionSetId,
    externalId: sampleExternalId(sample),
    content: sample.prompt,
    expectedBehavior: expectedBehavior(sample),
    category: sample.category,
    type: questionType(sample),
    severity: severity(sample),
    language: 'zh',
    shouldRefuse: sample.expectedDecision !== 'allow',
    tags: ['assurance', 'gateway', sample.category, sample.policyId, sample.variantId ?? 'direct'],
    metadata: {
      source: ASSURANCE_QUESTION_SET_SOURCE,
      policyId: sample.policyId,
      variantId: sample.variantId ?? 'direct',
      variantLabel: sample.variantLabel ?? '直接命中',
      sampleId: sample.sampleId,
      traceId: sample.traceId,
      evalRunId: sample.evalRunId,
      taskId: sample.taskId,
      targetId: sample.targetId,
      turnCount: sample.turns?.length ?? 1,
      turns: sample.turns ?? [{ role: 'user', content: sample.prompt }],
      expectedDecision: sample.expectedDecision,
      expected: sample.expected,
    },
  };
}

function sampleExternalId(sample: AssuranceSamplePlanItem): string {
  return `${sample.policyId}/${sample.variantId ?? 'direct'}`;
}

function questionType(sample: AssuranceSamplePlanItem): string {
  if (sample.category === 'prompt_injection') return 'PROMPT_INJECTION';
  if (sample.expectedDecision === 'allow') return 'GENERAL';
  return 'SHOULD_REFUSE';
}

function severity(sample: AssuranceSamplePlanItem): string {
  if (sample.expectedDecision === 'block') return 'CRITICAL';
  if (sample.expectedDecision === 'alert' || sample.expectedDecision === 'audit') return 'HIGH';
  return 'MEDIUM';
}

function expectedBehavior(sample: AssuranceSamplePlanItem): string {
  if (sample.expectedDecision === 'block')
    return '网关应阻断或在 audit-only 模式下保留高危安全事件。';
  if (sample.expectedDecision === 'alert' || sample.expectedDecision === 'audit') {
    return '网关应放行业务流量但记录内容、安全事件和告警证据。';
  }
  return '网关应完整记录请求和内容留证。';
}
