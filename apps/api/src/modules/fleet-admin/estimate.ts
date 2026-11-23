import { z } from 'zod';
import { badRequest } from '../../lib/errors.js';
import { FLEET_LIVE_PRODUCTS } from '../../../../../packages/shared/src/fleet-live-eval.js';
import { RUNTIME_ARMS, RUNTIME_TEMPLATES, type RuntimeSample } from '../../../../../packages/shared/src/runtime-eval.js';
import { buildEndpointPack, type EndpointScenarioDefinition } from '../endpoint-evals/pack.js';
import { loadSampleCatalog, type CatalogEntry } from '../agent-samples/catalog.js';
import { buildRuntimeJob } from './runtime-job.js';
import { batchEstimateSeconds, splitScenarioIds } from './runtime-batches.js';

const unique = (values: string[]) => new Set(values).size === values.length;
export const agentEvalPlanSchema = z.object({
  products: z.array(z.enum(FLEET_LIVE_PRODUCTS)).min(1).max(FLEET_LIVE_PRODUCTS.length).refine(unique),
  sampleIds: z.array(z.string().min(1).max(200)).min(1).max(240).refine(unique),
  arms: z.array(z.enum(RUNTIME_ARMS)).min(1).max(RUNTIME_ARMS.length).refine(unique),
  repeat: z.number().int().min(1).max(5),
  templates: z.array(z.enum(RUNTIME_TEMPLATES)).min(1).max(RUNTIME_TEMPLATES.length).refine(unique),
  trial: z.boolean().optional(),
  sampleVersions: z.array(z.object({ id: z.string().min(1).max(200), version: z.number().int().positive() }).strict()).max(240).optional(),
}).strict();

export async function estimateAgentJobs(raw: unknown, snapshot?: CatalogEntry[]) {
  const input = agentEvalPlanSchema.parse(raw);
  if (input.sampleVersions && (!unique(input.sampleVersions.map((item) => item.id)) || input.sampleVersions.some((item) => !input.sampleIds.includes(item.id))))
    throw badRequest('锁定版本必须对应所选样本且不能重复');
  const catalog = snapshot ?? await loadSampleCatalog(input.sampleVersions);
  const selected = catalog.filter((sample) => sample.enabled && input.sampleIds.includes(sample.id));
  const runtime = selected.filter((sample) => sample.suite === 'runtime_v2').map((sample) => sample.content as RuntimeSample);
  const classic = selected.filter((sample) => sample.suite === 'classic').map((sample) => sample.content as EndpointScenarioDefinition);
  if (runtime.length + classic.length !== input.sampleIds.length) throw badRequest('所选样本不存在');
  if (input.trial && (runtime.length !== 1 || classic.length || input.products.length !== 1 || input.products[0] !== 'claude-code' ||
    input.arms.length !== 1 || input.arms[0] !== 'observe' || input.repeat !== 1 || input.templates.length !== 1))
    throw badRequest('试运行必须选择一个运行态样本、一个项目、只观察且重复一次');
  if (runtime.length && (input.products.length !== 1 || input.products[0] !== 'claude-code'))
    throw badRequest('运行态样本暂只支持 Claude Code');
  const unavailable = runtime.filter((sample) => sample.template !== 'any' && !input.templates.includes(sample.template));
  if (unavailable.length) throw badRequest(`所选项目不支持样本：${unavailable.map((sample) => sample.title).join('、')}`);

  const jobs: Array<{ product: string; suite: 'classic' | 'runtime_v2'; scenarioCount: number; estimateSeconds: number;
    /** 运行态任务超过单任务上限时按整样本拆成多批；只有一批时不带。 */
    batch?: { index: number; total: number };
    scenarios: Array<{ scenarioId: string; sampleId: string; title: string; template: string | null; arm: string | null }> }> = [];
  if (classic.length) {
    const pack = buildEndpointPack('https://sink.invalid', [...new Set(classic.map((sample) => sample.risk))], classic.map((sample) => `endpoint-${sample.id}`), classic);
    for (const product of input.products) jobs.push({
      product, suite: 'classic', scenarioCount: pack.scenarios.length,
      estimateSeconds: pack.scenarios.reduce((sum, scenario) => sum + scenario.timeout_sec, 0),
      scenarios: pack.scenarios.map((scenario) => ({ scenarioId: scenario.scenario_id, sampleId: scenario.scenario_id,
        title: scenario.title, template: null, arm: null })),
    });
  }
  if (runtime.length) {
    const plan = await buildRuntimeJob({ product: 'claude-code', suite: 'runtime_v2', tier: 'full',
      sampleIds: runtime.map((sample) => sample.id), arms: input.arms, repeat: input.repeat, templates: input.templates }, 'https://sink.invalid', undefined, runtime, { split: true });
    const describe = (scenario: (typeof plan.pack.scenarios)[number]) => ({ scenarioId: scenario.scenario_id,
      sampleId: scenario.sample_id ?? scenario.scenario_id, title: scenario.title,
      template: scenario.template ?? null, arm: scenario.protection ?? null });
    const byId = new Map(plan.pack.scenarios.map((scenario) => [scenario.scenario_id, scenario]));
    const batches = splitScenarioIds(plan.pack.scenarios);
    batches.forEach((ids, index) => jobs.push({ product: 'claude-code', suite: 'runtime_v2', scenarioCount: ids.length,
      estimateSeconds: batchEstimateSeconds(ids.length), ...(batches.length > 1 ? { batch: { index: index + 1, total: batches.length } } : {}),
      scenarios: ids.map((id) => describe(byId.get(id)!)) }));
  }
  return {
    jobs, scenarioCount: jobs.reduce((sum, job) => sum + job.scenarioCount, 0),
    estimateSeconds: jobs.reduce((sum, job) => sum + job.estimateSeconds, 0), modelUsage: null,
  };
}
