import type {
  AgentAttackTechnique,
  AgentEvalLevel,
  AgentEvalStrengthConfig,
  AgentRiskSurface,
} from './types.js';
import { ALL_AGENT_ATTACK_MOVE_IDS } from './packs/moves.js';

export const AGENT_RISK_SURFACES = [
  'ssrf',
  'secret_read',
  'file_read',
  'dangerous_command',
  'data_exfiltration',
  'indirect_prompt_injection',
  'tool_argument_bypass',
] as const satisfies readonly AgentRiskSurface[];

const CORE_RISK_SURFACES = AGENT_RISK_SURFACES;

/**
 * 强度档真正决定"测什么招式"，而不是"测多少条"。
 *
 * baseline 池每条模板已携带 attackTechnique，这里按招式覆盖广度划分强度：
 *   smoke      只测最容易被识破的 boundary_reframe —— 验证基本守卫能跑通
 *   standard   + task_splitting + authority_override —— 覆盖最常见的"骗手"模式
 *   deep       + payload_smuggling + tool_substitution —— 加上间接注入和工具替换
 *   adversarial 全 6 招 + 多轮自适应变形 —— 真正"越打越强"
 *
 * defaultSampleCount 改为 baseline 抽样目标，而非"复读次数"。
 */
const STRENGTHS = {
  smoke: {
    level: 'smoke',
    label: '快速冒烟',
    defaultSampleCount: 10,
    minSampleCount: 4,
    maxSampleCount: 20,
    maxTurns: 1,
    variantDepth: 1,
    riskSurfaces: ['ssrf', 'secret_read', 'dangerous_command', 'indirect_prompt_injection'],
    techniques: ['boundary_reframe'] as readonly AgentAttackTechnique[],
    adaptiveRounds: 0,
  },
  standard: {
    level: 'standard',
    label: '标准上线',
    defaultSampleCount: 30,
    minSampleCount: 12,
    maxSampleCount: 60,
    maxTurns: 2,
    variantDepth: 2,
    riskSurfaces: CORE_RISK_SURFACES,
    techniques: [
      'boundary_reframe',
      'task_splitting',
      'authority_override',
    ] as readonly AgentAttackTechnique[],
    adaptiveRounds: 1,
  },
  deep: {
    level: 'deep',
    label: '深度红队',
    defaultSampleCount: 50,
    minSampleCount: 24,
    maxSampleCount: 120,
    maxTurns: 3,
    variantDepth: 3,
    riskSurfaces: CORE_RISK_SURFACES,
    techniques: [
      'boundary_reframe',
      'task_splitting',
      'authority_override',
      'payload_smuggling',
      'tool_substitution',
    ] as readonly AgentAttackTechnique[],
    adaptiveRounds: 2,
  },
  adversarial: {
    level: 'adversarial',
    label: '对抗研究',
    defaultSampleCount: 60,
    minSampleCount: 30,
    maxSampleCount: 180,
    maxTurns: 4,
    variantDepth: 4,
    riskSurfaces: CORE_RISK_SURFACES,
    techniques: ALL_AGENT_ATTACK_MOVE_IDS,
    adaptiveRounds: 4,
  },
} as const satisfies Record<AgentEvalLevel, AgentEvalStrengthConfig>;

export function isAgentEvalLevel(value: unknown): value is AgentEvalLevel {
  return typeof value === 'string' && value in STRENGTHS;
}

export function resolveAgentEvalStrength(level: unknown): AgentEvalStrengthConfig {
  const key = isAgentEvalLevel(level) ? level : 'standard';
  const cfg = STRENGTHS[key];
  return {
    ...cfg,
    riskSurfaces: [...cfg.riskSurfaces],
    techniques: [...cfg.techniques],
  };
}
