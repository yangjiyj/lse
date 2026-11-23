import type { AgentAttackPack, AgentAttackTemplate, McpAttackPack } from '../types.js';
import { BOUNDARY_REFRAME_TEMPLATES } from './l1-reframe.js';
import { TASK_SPLITTING_TEMPLATES } from './l2-split.js';
import { PAYLOAD_SMUGGLING_TEMPLATES } from './l3-smuggle.js';
import { ARGUMENT_OBFUSCATION_TEMPLATES } from './l4-obfuscate.js';
import { TOOL_SUBSTITUTION_TEMPLATES } from './l5-subst.js';
import { AUTHORITY_OVERRIDE_TEMPLATES } from './l6-authority.js';
import { MCP_ATTACK_TEMPLATES } from './l7-mcp.js';

export const BUILTIN_AGENT_ATTACK_PACK_VERSION = 'builtin-agent-attacks@2026-07-01.1';

/**
 * 内置 Agent 攻击模板池：6 层攻击招式 × 10 条 = 60 条 baseline。
 *
 * 分层维度是 Agent 专属的攻击招式（骗手 / 骗工具调用决定），不是 riskSurface，
 * 因为同一个 riskSurface 下不同招式的检测路径和难度差异很大。
 *
 * 招式定义见 ./moves.ts，分层文件见 ./l1-reframe.ts ... ./l6-authority.ts。
 */
export const BUILTIN_AGENT_ATTACK_TEMPLATES: readonly AgentAttackTemplate[] = [
  ...BOUNDARY_REFRAME_TEMPLATES,
  ...TASK_SPLITTING_TEMPLATES,
  ...PAYLOAD_SMUGGLING_TEMPLATES,
  ...ARGUMENT_OBFUSCATION_TEMPLATES,
  ...TOOL_SUBSTITUTION_TEMPLATES,
  ...AUTHORITY_OVERRIDE_TEMPLATES,
];

export const BUILTIN_AGENT_ATTACK_PACK: AgentAttackPack = {
  id: 'builtin-agent-attacks',
  version: BUILTIN_AGENT_ATTACK_PACK_VERSION,
  templates: BUILTIN_AGENT_ATTACK_TEMPLATES,
};

export const BUILTIN_MCP_ATTACK_PACK_VERSION = 'builtin-mcp-attacks@2026-10-15.2';

/**
 * 内置 MCP 攻击模板池（L7 层，六类：tool_poisoning / param_ssrf / credential_exfil /
 * destructive_command / shadow_tool / rug_pull）。
 *
 * 与 BUILTIN_AGENT_ATTACK_PACK 刻意分离：MCP 走 tools/call 或 control-plane 管理端点，
 * 由 generateMcpScenarios 采样成 metadata.kind='mcp_runtime' 的 Question，
 * 不进入 generateAgentScenarios 的沙箱采样池（详见 types.ts 的说明）。
 */
export const BUILTIN_MCP_ATTACK_PACK: McpAttackPack = {
  id: 'builtin-mcp-attacks',
  version: BUILTIN_MCP_ATTACK_PACK_VERSION,
  templates: MCP_ATTACK_TEMPLATES,
};
