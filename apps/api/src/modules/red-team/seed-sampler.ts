import { makeRng } from '../generator/core/prng.js';

export const RED_TEAM_DEFAULT_SAMPLE_COUNT = 4;

export const RED_TEAM_FALLBACK_VARIANTS = [
  'direct',
  'roleplay',
  'authority',
  'stepwise',
  'obfuscation',
  'indirect',
] as const;

export interface RedTeamSelectableQuestion {
  id: string;
  metadata?: unknown;
}

export interface SelectedRedTeamQuestion<T extends RedTeamSelectableQuestion> {
  question: T;
  objectiveKey: string;
  variant: string;
  selectionIndex: number;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redteamMetadata(value: unknown): Record<string, unknown> {
  if (!isRecordValue(value)) return {};
  return isRecordValue(value.redteam) ? value.redteam : {};
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function objectiveKeyOf(question: RedTeamSelectableQuestion): string {
  const redteam = redteamMetadata(question.metadata);
  return stringField(redteam.objectiveId) || `question:${question.id}`;
}

function variantOf(question: RedTeamSelectableQuestion): string {
  const redteam = redteamMetadata(question.metadata);
  return stringField(redteam.variant);
}

function filterByObjectiveIds<T extends RedTeamSelectableQuestion>(
  questions: readonly T[],
  objectiveIds: readonly string[] | undefined,
): readonly T[] {
  if (!objectiveIds || objectiveIds.length === 0) return questions;
  const whitelist = new Set(objectiveIds);
  const filtered = questions.filter((q) => whitelist.has(objectiveKeyOf(q)));
  // 白名单与候选包无交集时回落到全量，避免方向选了却抽不到题。
  return filtered.length > 0 ? filtered : questions;
}

function clampSampleCount(value: number | undefined, candidateCount: number): number {
  if (candidateCount <= 0) return 0;
  const normalized =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.floor(value)
      : RED_TEAM_DEFAULT_SAMPLE_COUNT;
  return Math.max(1, Math.min(normalized, candidateCount));
}

export function selectRedTeamQuestions<T extends RedTeamSelectableQuestion>(
  questions: readonly T[],
  options: {
    seed: string;
    sampleCount?: number;
    fallbackVariants?: readonly string[];
    /** 攻击方向白名单：只在这些风险目标内抽样；无匹配时回落到全量，避免空结果。 */
    objectiveIds?: readonly string[];
    /** 方向链路偏好变体：同一风险目标内优先选用这些攻击框架的样本。 */
    preferVariants?: readonly string[];
  },
): SelectedRedTeamQuestion<T>[] {
  const pool = filterByObjectiveIds(questions, options.objectiveIds);
  const sampleCount = clampSampleCount(options.sampleCount, pool.length);
  if (sampleCount === 0) return [];

  const rng = makeRng(`${options.seed}:${pool.length}:${sampleCount}`);
  const preferred =
    options.preferVariants && options.preferVariants.length > 0
      ? new Set(options.preferVariants)
      : null;
  const groups = new Map<string, T[]>();
  for (const question of pool) {
    const key = objectiveKeyOf(question);
    const group = groups.get(key) ?? [];
    group.push(question);
    groups.set(key, group);
  }

  const pickFromGroup = (group: T[]): T => {
    if (preferred) {
      const matches = group.filter((q) => preferred.has(variantOf(q)));
      if (matches.length > 0) return rng.pick(matches);
    }
    return rng.pick(group);
  };

  const selected: Array<{ question: T; objectiveKey: string }> = [];
  const groupKeys = rng.shuffle([...groups.keys()]);
  for (const key of groupKeys) {
    if (selected.length >= sampleCount) break;
    const group = groups.get(key);
    if (!group?.length) continue;
    selected.push({ question: pickFromGroup(group), objectiveKey: key });
  }

  if (selected.length < sampleCount) {
    const picked = new Set(selected.map((item) => item.question.id));
    let remaining = rng.shuffle(pool.filter((item) => !picked.has(item.id)));
    if (preferred) {
      // 填充阶段也先用尽方向链路里的攻击框架，再回落到其它变体。
      remaining = [
        ...remaining.filter((q) => preferred.has(variantOf(q))),
        ...remaining.filter((q) => !preferred.has(variantOf(q))),
      ];
    }
    for (const question of remaining) {
      if (selected.length >= sampleCount) break;
      selected.push({ question, objectiveKey: objectiveKeyOf(question) });
    }
  }

  const variants =
    options.fallbackVariants && options.fallbackVariants.length > 0
      ? options.fallbackVariants
      : RED_TEAM_FALLBACK_VARIANTS;

  // 候选行来自数据库时，nested create 的 UUID/时间顺序可能漂移；如果随机恰好把
  // 所有目标都选成同一显式变体，审计覆盖会退化。无方向偏好时做一次确定性补偿，
  // 只替换同一 objective 内的另一变体，不改变目标去重和 seed 可复现性。
  if (!preferred && selected.length > 1) {
    const explicitVariants = new Set(pool.map(variantOf).filter(Boolean));
    const selectedVariants = new Set(
      selected.map((item) => variantOf(item.question)).filter(Boolean),
    );
    if (explicitVariants.size > 1 && selectedVariants.size === 1) {
      const currentVariant = [...selectedVariants][0];
      const alternate = pool.find(
        (question) =>
          variantOf(question) &&
          variantOf(question) !== currentVariant &&
          selected.some((item) => item.objectiveKey === objectiveKeyOf(question)),
      );
      if (alternate) {
        const index = selected.findIndex((item) => item.objectiveKey === objectiveKeyOf(alternate));
        const selectedItem = index >= 0 ? selected[index] : undefined;
        if (selectedItem) selectedItem.question = alternate;
      }
    }
  }

  const fallbackAssignments = selected.map(() => rng.pick(variants));
  if (!preferred && fallbackAssignments.length > 1 && variants.length > 1) {
    const assigned = new Set(fallbackAssignments);
    const firstFallback = fallbackAssignments[0];
    if (assigned.size === 1 && firstFallback) {
      const secondFallback = variants.find((variant) => variant !== firstFallback);
      if (secondFallback) fallbackAssignments[1] = secondFallback;
    }
  }

  return selected.map((item, index) => ({
    ...item,
    variant:
      variantOf(item.question) ||
      fallbackAssignments[index] ||
      variants[index % variants.length] ||
      RED_TEAM_FALLBACK_VARIANTS[0],
    selectionIndex: index + 1,
  }));
}
