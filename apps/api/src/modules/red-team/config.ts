import type { AttackMoveId, RedTeamConfig } from './types.js';
import { ALL_MOVE_IDS, MOVES } from './moves.js';
import { RED_TEAM_DEFAULT_ROUNDS } from '@lse/shared';

export const RED_TEAM_SETTING_KEY = 'redteam.config';

export const DEFAULT_RED_TEAM_CONFIG = {
  moves: ALL_MOVE_IDS,
  maxRounds: RED_TEAM_DEFAULT_ROUNDS,
  noProgressK: 3,
  budgetTokens: null as number | null,
  breakOn: 'verdict' as 'verdict' | 'attitude',
  judgeTargetId: '',
  secondaryAttackerTargetId: '',
  attackerMaxTokens: 512,
  targetMaxTokens: 1024,
  judgeMaxTokens: 512,
};

const MOVE_ID_SET = new Set<string>(ALL_MOVE_IDS);
const LEGACY_MOVE_ALIASES: Readonly<Record<string, AttackMoveId>> = {
  身份冒充诱导: 'identity_spoof',
  任务拆分绕过: 'stepwise_decompose',
  虚假前提构造: 'fictional_frame',
  情绪施压: 'authority_pressure',
};
const MOVE_NAME_ALIASES = new Map<string, AttackMoveId>([
  ...ALL_MOVE_IDS.map((id) => [id, id] as const),
  ...ALL_MOVE_IDS.map((id) => [MOVES[id].name, id] as const),
  ...Object.entries(LEGACY_MOVE_ALIASES),
]);

export function normalizeConfiguredMoves(value: unknown): AttackMoveId[] {
  if (!Array.isArray(value)) return [...DEFAULT_RED_TEAM_CONFIG.moves];
  const normalized: AttackMoveId[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const candidate = item.trim();
    const move = MOVE_ID_SET.has(candidate)
      ? (candidate as AttackMoveId)
      : MOVE_NAME_ALIASES.get(candidate);
    if (move && !normalized.includes(move)) normalized.push(move);
  }
  return normalized.length > 0 ? normalized : [...DEFAULT_RED_TEAM_CONFIG.moves];
}

function resolveMaxTokens(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export type SettingLoader = (key: string) => Promise<Record<string, unknown> | null>;

/** 合并：默认 < 全局(SystemSetting) < 题级(Question.metadata.redteam)。 */
export async function resolveRedTeamConfig(
  questionMeta: Record<string, unknown> | null,
  loadSetting: SettingLoader,
): Promise<RedTeamConfig> {
  const global = (await loadSetting(RED_TEAM_SETTING_KEY)) ?? {};
  const perQ = (questionMeta?.redteam as Record<string, unknown> | undefined) ?? {};
  const merged: Record<string, unknown> = { ...DEFAULT_RED_TEAM_CONFIG, ...global, ...perQ };
  const gatewayTargetId = String(merged.gatewayTargetId ?? '');
  const attackerTargetId = String(merged.attackerTargetId ?? '');
  if (!attackerTargetId) throw new Error('red-team: 缺少 attackerTargetId');
  return {
    moves: normalizeConfiguredMoves(merged.moves),
    // 执行期按题级快照原样执行（历史任务复测保持原轮数）；新建任务的 ≥5 轮约束在路由校验层。
    maxRounds: Number(merged.maxRounds ?? RED_TEAM_DEFAULT_ROUNDS),
    noProgressK: Number(merged.noProgressK ?? 3),
    budgetTokens: (merged.budgetTokens as number | null) ?? null,
    gatewayTargetId,
    attackerTargetId,
    breakOn: merged.breakOn === 'attitude' ? 'attitude' : 'verdict',
    judgeTargetId: String(merged.judgeTargetId ?? ''),
    secondaryAttackerTargetId: String(merged.secondaryAttackerTargetId ?? ''),
    attackerMaxTokens: resolveMaxTokens(merged.attackerMaxTokens, 512),
    targetMaxTokens: resolveMaxTokens(merged.targetMaxTokens, 1024),
    judgeMaxTokens: resolveMaxTokens(merged.judgeMaxTokens, 512),
  };
}
