import type { EngineResult, EngineRunResult, JudgeInput } from '@lse/shared';

/**
 * 单题判定引擎：对单个「题目 + 模型回答」给出归一化裁决。
 * 既覆盖内置纯函数引擎（规则/敏感信息），也覆盖外部 sidecar（如 llm-guard）。
 */
export interface PerQuestionEngine {
  /** 引擎标识，与 EngineResult.engine / EngineRun.engine 对应。 */
  readonly engine: string;
  /** 是否为内置纯函数引擎（始终可用、无网络依赖）。 */
  readonly builtin?: boolean;
  /**
   * 判定单题。实现必须「绝不抛出」：外部依赖不可用时返回 status='skipped' 的 EngineResult，
   * 由执行器据此写 SKIPPED 的 EngineRun，从而让主闭环永不被外部引擎拖垮。
   */
  judge(input: JudgeInput): Promise<EngineResult>;
}

/** 任务级扫描目标（红队类引擎按「模型 + 题目种子」整体扫描，而非逐题判定）。 */
export interface TaskScanTarget {
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

/** 任务级扫描上下文：传给红队 / 基础设施类引擎。 */
export interface TaskScanContext {
  readonly taskId: string;
  readonly target: TaskScanTarget;
  /** 题库中抽取的提示词种子（红队引擎可用作攻击语料的一部分）。 */
  readonly promptSeeds: string[];
  /** 单次扫描的总超时（毫秒）。 */
  readonly timeoutMs: number;
}

/** 任务级引擎：对整个任务 / 模型做一次扫描，产出任务级风险项与一条运行记录。 */
export interface TaskLevelEngine {
  readonly engine: string;
  /** 执行任务级扫描。实现必须「绝不抛出」：不可用 / 超时返回 status='SKIPPED' 的 EngineRunResult。 */
  scan(ctx: TaskScanContext): Promise<EngineRunResult>;
}
