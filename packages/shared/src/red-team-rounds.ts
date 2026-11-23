/**
 * 红队实战对抗轮数约束：前后端共用。
 * 招标要求“持续完成不少于5轮的对抗执行”，因此新建任务与全局策略的最小/默认轮数均 ≥ 5。
 */
export const RED_TEAM_MIN_ROUNDS = 5;
export const RED_TEAM_DEFAULT_ROUNDS = 6;
export const RED_TEAM_MAX_ROUNDS_LIMIT = 20;

/**
 * 兼容读取历史配置：旧版本允许 1–4 轮，读取时提升到最小轮数，非法值回落默认值，超上限截断。
 */
export function normalizeRedTeamMaxRounds(value: unknown): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return RED_TEAM_DEFAULT_ROUNDS;
  const rounded = Math.floor(n);
  if (rounded < RED_TEAM_MIN_ROUNDS) return RED_TEAM_MIN_ROUNDS;
  if (rounded > RED_TEAM_MAX_ROUNDS_LIMIT) return RED_TEAM_MAX_ROUNDS_LIMIT;
  return rounded;
}
