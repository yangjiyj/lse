import { createDummyAttackerHead } from './dummy-attacker.js';
import { createReActAttackerHead, type ReActDeps } from './react-attacker.js';
import type { AttackerHead, ChatFn } from './types.js';

/**
 * 攻击脑工厂。
 *
 * - "dummy"：固定脚本攻击脑（dummy-attacker.ts），仅供测试，用于把「录一遍·放两遍·判·报」链路打通。
 * - "react"：真实 ReAct 攻击脑（react-attacker.ts，THINK→ACT→OBSERVE），生产默认。
 *
 * chat 为可选注入点（测试桩 / 自定义 LLM 客户端）；不传则各攻击脑回退到内置 chatComplete。
 * deps 为 react 攻击脑的独立攻击脑注入通道（loadAttackerTarget）；仅 react 分支透传，
 * dummy 无独立攻击脑概念，不接收 deps。
 */
export function resolveAttackerHead(
  name: 'dummy' | 'react',
  chat?: ChatFn,
  deps?: ReActDeps,
): AttackerHead {
  return name === 'react' ? createReActAttackerHead(chat, deps) : createDummyAttackerHead(chat);
}

export * from './types.js';
export { runRedTeamAttack } from './pipe.js';
export { persistPair, redTeamPrismaStore } from './store.js';
export type { RedTeamStore } from './store.js';
export {
  attackMemoryKey,
  createInMemoryAttackMemoryStore,
  prismaAttackMemoryStore,
  shouldRememberAttack,
} from './attack-memory.js';
export type { AttackMemoryEntry, AttackMemoryRecord, AttackMemoryStore } from './attack-memory.js';
export { resolveRedTeamConfig } from './config.js';
