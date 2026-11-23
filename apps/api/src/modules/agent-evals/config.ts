/**
 * Agent 场景化测评的系统级配置键。
 *
 * 与 red-team.config 平级,放在 systemSetting 表里,key='agent_eval.config'。
 * 字段:
 *   - attackerTargetId:attacker LLM 的 ModelTarget id(攻击脑);空则不启用自适应攻击
 *   - judgeTargetId:Agent LLM 裁判的 ModelTarget id;空则不启用 LLM 裁判
 *       (注:executor 的全局 JUDGE 类 ModelTarget 也会自动喂给 agent-llm-judge 引擎,
 *        这里是 Agent 场景的显式覆盖,优先级高于全局 JUDGE)
 *   - adaptiveRounds:每条 baseline 跑多少轮 attacker 变形(0=关,默认 2)
 *   - enabled:Agent 场景自适应攻击总开关(关掉则即使配了 target 也不跑)
 */
export const AGENT_EVAL_SETTING_KEY = 'agent_eval.config';

export const DEFAULT_AGENT_EVAL_CONFIG = {
  attackerTargetId: '',
  judgeTargetId: '',
  adaptiveRounds: 2,
  enabled: false,
  // 防骗体检会触发真通道工具调用与外部 sink，默认关闭；仅显式配置 true 才启用。
  fanoutEnabled: false,
};

export type AgentEvalSettings = typeof DEFAULT_AGENT_EVAL_CONFIG;

export type AgentEvalSettingLoader = (key: string) => Promise<Record<string, unknown> | null>;

/** 合并:默认 < systemSetting('agent_eval.config')。 */
export async function resolveAgentEvalConfig(
  loadSetting: AgentEvalSettingLoader,
): Promise<AgentEvalSettings> {
  const stored = (await loadSetting(AGENT_EVAL_SETTING_KEY)) ?? {};
  return {
    attackerTargetId: String(stored.attackerTargetId ?? DEFAULT_AGENT_EVAL_CONFIG.attackerTargetId),
    judgeTargetId: String(stored.judgeTargetId ?? DEFAULT_AGENT_EVAL_CONFIG.judgeTargetId),
    adaptiveRounds:
      typeof stored.adaptiveRounds === 'number' && Number.isFinite(stored.adaptiveRounds)
        ? Math.max(0, Math.min(8, Math.floor(stored.adaptiveRounds)))
        : DEFAULT_AGENT_EVAL_CONFIG.adaptiveRounds,
    enabled: stored.enabled === true,
    // 仅当配置显式存了布尔值时才尊重它；缺省回落到安全默认（false）。
    fanoutEnabled:
      typeof stored.fanoutEnabled === 'boolean'
        ? stored.fanoutEnabled
        : DEFAULT_AGENT_EVAL_CONFIG.fanoutEnabled,
  };
}
