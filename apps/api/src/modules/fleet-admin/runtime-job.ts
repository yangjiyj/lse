// 运行态测评 v2（suite=runtime_v2）的任务创建：请求解析、默认值、规模估算、场景包构建、能力检查。
// 路由（routes.ts）只负责把这里算出的场景包交给通用的创建流程；样本与场景由 C1 的 buildRuntimePack 生成，这里不写样本。
import type { z } from 'zod';
import { AppError, badRequest, conflict } from '../../lib/errors.js';
import {
  RUNTIME_AVG_SCENARIO_SECONDS,
  RUNTIME_MAX_ESTIMATE_SECONDS,
  RUNTIME_MAX_SCENARIOS,
  RUNTIME_TIERS,
  type RuntimeArm,
  type RuntimeTemplate,
  type RuntimeTier,
  type RuntimeVector,
  type RuntimeSample,
} from '../../../../../packages/shared/src/runtime-eval.js';
import { fleetEvalJobRequestSchema } from '../endpoint-evals/config.js';
import type { EndpointPack } from '../endpoint-evals/pack.js';
import { runtimeV2Supported } from './agents.js';

export type FleetEvalJobBody = z.infer<typeof fleetEvalJobRequestSchema>;

/** 与 C1 samples/build-pack.ts 的 BuildRuntimePackOptions 保持一致。 */
export interface RuntimePackOptions {
  tier: RuntimeTier;
  vectors?: RuntimeVector[];
  arms: RuntimeArm[];
  repeat: number;
  templates: RuntimeTemplate[];
  sampleIds?: string[];
  sinkBaseUrl: string;
  samples?: RuntimeSample[];
}
export type RuntimeEstimateOptions = Omit<RuntimePackOptions, 'sinkBaseUrl'>;

/** 场景包生成依赖。默认实现动态加载 C1 的样本库；测试注入桩。 */
export interface RuntimePackDeps {
  buildRuntimePack(opts: RuntimePackOptions): EndpointPack | Promise<EndpointPack>;
  estimateRuntimePack(opts: RuntimeEstimateOptions): { scenarios: number; seconds: number };
}

const BUILD_PACK_MODULE = '../endpoint-evals/samples/build-pack.js';

/** 动态加载 C1 的 build-pack.js。用变量作模块名，样本库未合入时 tsc 不会因缺模块报错。 */
export async function loadDefaultRuntimePackDeps(): Promise<RuntimePackDeps> {
  let mod: Partial<RuntimePackDeps>;
  try {
    mod = (await import(/* @vite-ignore */ BUILD_PACK_MODULE)) as Partial<RuntimePackDeps>;
  } catch {
    throw new AppError(503, '运行态测评样本库尚未部署，暂时无法创建运行态测评任务', 'FLEET_RUNTIME_SAMPLES_UNAVAILABLE');
  }
  if (typeof mod.buildRuntimePack !== 'function' || typeof mod.estimateRuntimePack !== 'function')
    throw new AppError(503, '运行态测评样本库版本不匹配，暂时无法创建运行态测评任务', 'FLEET_RUNTIME_SAMPLES_UNAVAILABLE');
  return { buildRuntimePack: mod.buildRuntimePack, estimateRuntimePack: mod.estimateRuntimePack };
}

let depsOverride: RuntimePackDeps | null = null;
/** 仅测试使用：注入桩；传 null 恢复默认实现。 */
export function setRuntimePackDepsForTest(deps: RuntimePackDeps | null): void {
  depsOverride = deps;
}

/**
 * 解析创建请求。运行态相关的跨字段错误（经典测评带了运行态字段、运行态带了经典字段、产品不支持）
 * 把中文原因直接作为 400 的 message；其余校验错误仍抛 ZodError，行为与升级前一致。
 */
export function parseFleetEvalJobRequest(raw: unknown): FleetEvalJobBody {
  const parsed = fleetEvalJobRequestSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  const own = parsed.error.issues.filter(
    (issue) => issue.code === 'custom' && (issue.params as { runtimeRequest?: boolean } | undefined)?.runtimeRequest === true,
  );
  if (own.length)
    throw badRequest(own.map((issue) => issue.message).join('；'), 'VALIDATION_ERROR', { issues: parsed.error.issues });
  throw parsed.error;
}

export const isRuntimeSuite = (body: Pick<FleetEvalJobBody, 'suite'>): boolean => body.suite === 'runtime_v2';

export interface ResolvedRuntimeOptions {
  tier: RuntimeTier;
  vectors?: RuntimeVector[];
  arms: RuntimeArm[];
  repeat: number;
  templates: RuntimeTemplate[];
  sampleIds?: string[];
}

/**
 * 缺省值：tier=standard；arms quick 只有 observe；repeat quick=1、standard=2、full=3；templates full 两者、其余 py-service-v1。
 * 标准档原为 3 次（180 个场景），按真机平均 122 秒估算约 6.5 小时，超过 6 小时上限，改为 2 次（120 个场景，约 4.3 小时）。
 */
export function resolveRuntimeOptions(body: FleetEvalJobBody): ResolvedRuntimeOptions {
  const tier: RuntimeTier = body.tier ?? 'standard';
  return {
    tier,
    ...(body.vectors ? { vectors: body.vectors } : {}),
    arms: body.arms ?? (tier === 'quick' ? ['observe'] : ['observe', 'enforce']),
    repeat: body.repeat ?? (tier === 'quick' ? 1 : tier === 'standard' ? 2 : 3),
    templates: body.templates ?? (tier === 'full' ? ['py-service-v1', 'node-api-v1'] : ['py-service-v1']),
    ...(body.sampleIds ? { sampleIds: body.sampleIds } : {}),
  };
}

export interface RuntimeJobPlan extends ResolvedRuntimeOptions {
  pack: EndpointPack;
  scenarioCount: number;
  estimateSeconds: number;
}

const SHRINK_HINT = '请缩小范围：减少攻击类别、重复次数、项目模板或防护臂';
const hours = (seconds: number) => Math.round((seconds / 3600) * 10) / 10;
const messageOf = (error: unknown) =>
  error instanceof AppError ? error : badRequest(error instanceof Error && error.message ? error.message : '运行态测评范围不合法');

/** 估算规模并校验上限，通过后生成场景包。超限、范围不合法一律 400。 */
export async function buildRuntimeJob(
  body: FleetEvalJobBody,
  sink: string,
  deps?: RuntimePackDeps,
  samples?: RuntimeSample[],
  /** split=true：调用方会把结果按 RUNTIME_MAX_JOB_SCENARIOS 拆成多个任务，整体耗时不再受单任务上限限制。 */
  splitOptions: { split?: boolean } = {},
): Promise<RuntimeJobPlan> {
  const options = resolveRuntimeOptions(body);
  const packOptions = samples ? { ...options, samples } : options;
  const api = deps ?? depsOverride ?? (await loadDefaultRuntimePackDeps());
  let estimate: { scenarios: number; seconds: number };
  try {
    estimate = api.estimateRuntimePack(packOptions);
  } catch (error) {
    throw messageOf(error);
  }
  const limits = {
    scenarios: estimate.scenarios,
    estimate_seconds: estimate.seconds,
    max_scenarios: RUNTIME_MAX_SCENARIOS,
    max_estimate_seconds: RUNTIME_MAX_ESTIMATE_SECONDS,
  };
  if (!Number.isInteger(estimate.scenarios) || estimate.scenarios < 1)
    throw badRequest('所选范围内没有可运行的样本，请调整攻击类别、项目模板或样本编号', 'FLEET_RUNTIME_EMPTY', limits);
  if (estimate.scenarios > RUNTIME_MAX_SCENARIOS)
    throw badRequest(
      `场景数 ${estimate.scenarios} 超过上限 ${RUNTIME_MAX_SCENARIOS}，${SHRINK_HINT}`,
      'FLEET_RUNTIME_TOO_LARGE',
      limits,
    );
  if (!splitOptions.split && estimate.seconds > RUNTIME_MAX_ESTIMATE_SECONDS)
    throw badRequest(
      `预计耗时 ${estimate.seconds} 秒（约 ${hours(estimate.seconds)} 小时）超过上限 ${RUNTIME_MAX_ESTIMATE_SECONDS} 秒（${hours(RUNTIME_MAX_ESTIMATE_SECONDS)} 小时），${SHRINK_HINT}`,
      'FLEET_RUNTIME_TOO_LONG',
      limits,
    );
  let pack: EndpointPack;
  try {
    pack = await api.buildRuntimePack({ ...packOptions, sinkBaseUrl: sink });
  } catch (error) {
    throw messageOf(error);
  }
  const scenarioCount = pack.scenarios.length;
  if (scenarioCount > RUNTIME_MAX_SCENARIOS)
    throw badRequest(
      `场景数 ${scenarioCount} 超过上限 ${RUNTIME_MAX_SCENARIOS}，${SHRINK_HINT}`,
      'FLEET_RUNTIME_TOO_LARGE',
      { ...limits, scenarios: scenarioCount },
    );
  return { ...options, pack, scenarioCount, estimateSeconds: estimate.seconds };
}

/**
 * 测评向导按样本发起时的档位：所选样本集合和哪个内置方案的样本一致，就用那个方案的档位，否则记 custom。
 * 只看样本、不看防护臂和重复次数，和接口直接传 tier 时的含义一致（tier 决定选哪些样本）。
 */
export function planTierOf(
  sampleIds: readonly string[],
  plans: ReadonlyArray<{ id: string; sampleIds: readonly string[] }>,
): RuntimeTier | 'custom' {
  const wanted = new Set(sampleIds);
  for (const plan of plans) {
    if (!(RUNTIME_TIERS as readonly string[]).includes(plan.id)) continue;
    const ids = new Set(plan.sampleIds);
    if (ids.size === wanted.size && [...wanted].every((id) => ids.has(id))) return plan.id as RuntimeTier;
  }
  return 'custom';
}

/** 契约 §8：任务名 `{主机名} 运行态测评（{product}·{tier}）`；测评向导发起、样本对不上内置方案时 tier 写 custom。 */
export const runtimeJobName = (
  hostname: string,
  product: string,
  tier: RuntimeTier | 'custom',
  batch?: { index: number; total: number },
): string => `${hostname} 运行态测评（${product}·${tier}${batch && batch.total > 1 ? `·第 ${batch.index}/${batch.total} 批` : ''}）`;

/** 终端心跳没有上报 eval_sandbox_v2 时拒绝（探针执行器过旧）。 */
export function assertRuntimeV2Capability(health: unknown): void {
  if (!runtimeV2Supported(health))
    throw conflict(
      '终端的测评执行器版本过旧，不支持运行态测评，请升级探针',
      'FLEET_SANDBOX_V2_UNSUPPORTED',
    );
}

/** 与服务端口径一致的估算：向上取整(场景数 × 平均耗时)。 */
export const estimateSecondsFor = (scenarioCount: number): number =>
  Math.ceil(scenarioCount * RUNTIME_AVG_SCENARIO_SECONDS);
