import { config } from '../../config.js';
import { createGarakEngine, GARAK_ENGINE } from './garak.js';
import { createPyritEngine, PYRIT_ENGINE } from './pyrit.js';
import { builtinPerQuestionEngines } from './builtin.js';
import { createAgentToolGuardEngine, AGENT_TOOL_GUARD_ENGINE } from './agent-tool-guard.js';
import { createAgentLlmJudgeEngine, AGENT_LLM_JUDGE_ENGINE } from './agent-llm-judge.js';
import { ENGINE_CATALOG, isEngineEnabled } from './catalog.js';
import { createPythonJudgeEngine, PYTHON_JUDGE_ENGINE } from './python-judge.js';
import { createLlmJudgeEngine, LLM_JUDGE_ENGINE } from './llm-judge.js';
import type { PerQuestionEngine, TaskLevelEngine } from './types.js';
import type { LlmTargetConfig } from '@lse/shared';

/**
 * 默认即启用 agent-tool-guard 的对象类型（Agent / API / MCP 入口）。
 * 纯 MODEL 不在其列：其文本兜底判定可能误判正常技术内容，故仅在显式勾选时启用。
 *
 * MCP_OPENAPI（MCP 测-堵-验闭环的被测对象）默认开 agent-tool-guard；
 * agent-llm-judge 在配置了全局评审模型 / LLM_JUDGE_* 时亦随 defaultAvailable 生效，
 * 二者复用现成判定引擎，MCP 闭环无需新造 judge。
 */
const AGENT_GUARD_DEFAULT_TARGET_TYPES = new Set(['AGENT_API', 'PUBLIC_AGENT', 'MCP_OPENAPI']);

/** 评审目标是否字段齐备、可直接用于 llm-judge。 */
function isUsableJudgeTarget(
  target: LlmTargetConfig | null | undefined,
): target is LlmTargetConfig {
  if (!target) return false;
  return (
    typeof target.baseUrl === 'string' &&
    target.baseUrl.trim().length > 0 &&
    typeof target.apiKey === 'string' &&
    target.apiKey.trim().length > 0 &&
    typeof target.model === 'string' &&
    target.model.trim().length > 0
  );
}

/**
 * 解析本次运行启用的单题引擎。
 * - selected 为空 → 使用按对象类型选择的基础判定；外部扫描按需显式选择。
 * - selected 非空 → 在可用引擎中按名称取交集（任务级自定义评估）。
 * - 交集为空（例如只勾选了任务级引擎）→ 保底回退内置两引擎，
 *   避免出现 0 个单题判定导致所有结果 finalVerdict=UNKNOWN。
 *
 * judgeTarget 为「全局评审模型」注入入口（来自 DB 里激活的 JUDGE ModelTarget），三态：
 * - undefined：未注入，回退环境变量 LLM_JUDGE_*（受 catalog 门控，向后兼容旧部署）；
 * - 可用配置：DB 全局评审模型，配置即开关，绕过门控直接启用 llm-judge；
 * - null / 字段不完整：调用方明确「无评审目标」，不启用 llm-judge。
 */
export function resolvePerQuestionEngines(
  selected: string[] = [],
  judgeTarget?: LlmTargetConfig | null,
  targetType?: string,
): PerQuestionEngine[] {
  const agentScenario =
    AGENT_GUARD_DEFAULT_TARGET_TYPES.has(targetType ?? '') ||
    selected.includes(AGENT_TOOL_GUARD_ENGINE) ||
    selected.includes(AGENT_LLM_JUDGE_ENGINE);
  const defaultAvailable: PerQuestionEngine[] = [...builtinPerQuestionEngines];
  const optionalAvailable: PerQuestionEngine[] = [];
  let configuredJudgeEngine: PerQuestionEngine | null = null;
  let configuredAgentJudgeEngine: PerQuestionEngine | null = null;
  if (isEngineEnabled(PYTHON_JUDGE_ENGINE)) {
    optionalAvailable.push(createPythonJudgeEngine({ baseUrl: config.PYTHON_JUDGE_URL }));
  }
  if (judgeTarget === undefined) {
    if (isEngineEnabled(LLM_JUDGE_ENGINE)) {
      defaultAvailable.push(
        createLlmJudgeEngine({
          target: {
            baseUrl: config.LLM_JUDGE_BASE_URL,
            apiKey: config.LLM_JUDGE_API_KEY,
            model: config.LLM_JUDGE_MODEL,
          },
          enabled: true,
          rubricEnabled: config.LLM_JUDGE_RUBRIC_ENABLED,
        }),
      );
    }
    if (agentScenario && isEngineEnabled(AGENT_LLM_JUDGE_ENGINE)) {
      configuredAgentJudgeEngine = createAgentLlmJudgeEngine({
        target: {
          baseUrl: config.LLM_JUDGE_BASE_URL,
          apiKey: config.LLM_JUDGE_API_KEY,
          model: config.LLM_JUDGE_MODEL,
        },
        enabled: true,
      });
      defaultAvailable.push(configuredAgentJudgeEngine);
    }
  } else if (isUsableJudgeTarget(judgeTarget)) {
    configuredJudgeEngine = createLlmJudgeEngine({
      target: judgeTarget,
      enabled: true,
      rubricEnabled: config.LLM_JUDGE_RUBRIC_ENABLED,
    });
    defaultAvailable.push(configuredJudgeEngine);
    // Agent 工具调用语义裁判复用同一评审 target（与被测模型解耦,避免同源偏置）。
    if (agentScenario) {
      configuredAgentJudgeEngine = createAgentLlmJudgeEngine({
        target: judgeTarget,
        enabled: true,
      });
      defaultAvailable.push(configuredAgentJudgeEngine);
    }
  }
  // Agent / API / MCP 类对象默认即启用 agent-tool-guard（无需显式勾选），纯 MODEL 不默认开。
  const guardOnByDefault =
    targetType !== undefined &&
    AGENT_GUARD_DEFAULT_TARGET_TYPES.has(targetType) &&
    isEngineEnabled(AGENT_TOOL_GUARD_ENGINE);
  if (guardOnByDefault) {
    defaultAvailable.push(createAgentToolGuardEngine());
  }
  const available: PerQuestionEngine[] = [...defaultAvailable, ...optionalAvailable];
  // 显式勾选可在任意对象类型上启用 agent-tool-guard；默认已加入时不再重复。
  if (!guardOnByDefault && isEngineEnabled(AGENT_TOOL_GUARD_ENGINE)) {
    available.push(createAgentToolGuardEngine());
  }
  if (selected.length === 0) return defaultAvailable;
  const picked = available.filter((e) => selected.includes(e.engine));
  if (picked.length === 0) {
    const base = configuredJudgeEngine
      ? [...builtinPerQuestionEngines, configuredJudgeEngine]
      : [...builtinPerQuestionEngines];
    return configuredAgentJudgeEngine ? [...base, configuredAgentJudgeEngine] : base;
  }
  if (configuredJudgeEngine && !picked.some((e) => e.engine === configuredJudgeEngine?.engine)) {
    picked.push(configuredJudgeEngine);
  }
  // Agent runtime 测评的语义裁判也要保底进 picked,避免被 selected 过滤掉。
  if (
    configuredAgentJudgeEngine &&
    !picked.some((e) => e.engine === configuredAgentJudgeEngine?.engine)
  ) {
    picked.push(configuredAgentJudgeEngine);
  }
  return picked;
}

/**
 * 解析本次运行启用的任务级引擎（红队类）。
 * - selected 为空 → 不自动发起额外的任务级扫描。
 * - selected 非空 → 按名称取交集；无匹配则为空（任务级引擎可被完全关闭）。
 */
export function resolveTaskLevelEngines(selected: string[] = []): TaskLevelEngine[] {
  const available: TaskLevelEngine[] = [];
  if (isEngineEnabled(GARAK_ENGINE)) {
    available.push(createGarakEngine({ baseUrl: config.GARAK_URL }));
  }
  if (isEngineEnabled(PYRIT_ENGINE)) {
    available.push(createPyritEngine({ baseUrl: config.PYRIT_URL }));
  }
  if (selected.length === 0) return [];
  return available.filter((e) => selected.includes(e.engine));
}

/**
 * 解析「用户显式勾选、但当前不可用」的任务级引擎（休眠态）。
 * - selected 为空 → 返回空（未勾选即不臆造跳过项，保持向后兼容静默）。
 * - selected 非空 → 在引擎目录中筛出 kind=task-level、被勾选、且当前 isEnabled()=false 的引擎名。
 *
 * 结果语义为「休眠引擎集合」：遍历 ENGINE_CATALOG 而非 selected，故输出按目录顺序、
 * 且天然对 selected 中的重复项去重（入参顺序/重复不影响输出）。
 *
 * 供执行器为这些休眠引擎补落 status=SKIPPED 的 EngineRun，使「跳过扫描」显式可见，
 * 杜绝任务级红队引擎被门控关闭后静默产出 0 扫描、被误读为「无风险」。
 */
export function resolveDormantTaskLevelEngines(selected: string[] = []): string[] {
  if (selected.length === 0) return [];
  return ENGINE_CATALOG.filter(
    (e) => e.kind === 'task-level' && selected.includes(e.engine) && !isEngineEnabled(e.engine),
  ).map((e) => e.engine);
}
