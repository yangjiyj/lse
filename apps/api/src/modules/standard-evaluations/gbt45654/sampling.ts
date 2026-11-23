import { sampleStandardItems } from '@lse/shared';
import {
  ANNEX_ITEM_CODES,
  GBT_MIN_SAMPLES,
  NON_REFUSAL_ASPECTS,
  NON_REFUSAL_ASPECT_QUOTA,
  REFUSAL_ITEM_CODES,
  REFUSAL_ITEM_QUOTA,
  generationItemQuota,
  type GbtBank,
} from './constants.js';

/** 题库里一道题进入抽样所需的最小字段（C1 契约的 metadata 摘出来）。 */
export interface BankQuestion {
  id: string;
  /** 附录 A 小项编号；非拒答题为 null。 */
  annexItem: string | null;
  /** 非拒答题的方面。 */
  aspect: string | null;
  clauseIds: readonly string[];
  /** 自动更新加入这道题的题库版本（metadata.addedInVersion）；内置原题没有。 */
  addedInVersion?: string | null;
}

export interface Stratum {
  key: string;
  /** 题库里这一层可抽的题数。 */
  available: number;
  /** 这一层的保底题数（附录 B 对题库每项的最低要求，抽样时同样保底）。 */
  quota: number;
}

export interface StratumAllocation {
  key: string;
  available: number;
  quota: number;
  selected: number;
  /** 题库该层不足保底题数的缺口。 */
  shortfall: number;
}

function hashOrder(keys: readonly string[], seed: string): string[] {
  // 层顺序只影响凑整时谁多拿一题；用种子打乱，保证可复现且不偏向前面的编号。
  const ranked = keys.map((key) => ({ key, rank: fnv(`${seed}|${key}`) }));
  ranked.sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
  return ranked.map((r) => r.key);
}

function fnv(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 分层配额：
 * 1. 先给每层保底题数（不超过题库可用数）；
 * 2. 目标总数大于保底之和时，余量在还有题可抽的层之间逐题轮流分配（尽量均衡）；
 * 3. 目标总数小于保底之和时，不用保底，直接在各层间均衡分配；
 * 4. 总数超过题库总量时按题库总量封顶。
 */
export function allocateStrata(
  strata: readonly Stratum[],
  total: number,
  seed: string,
): StratumAllocation[] {
  const order = hashOrder(
    strata.map((s) => s.key),
    seed,
  );
  const byKey = new Map(strata.map((s) => [s.key, s]));
  const selected = new Map<string, number>(strata.map((s) => [s.key, 0]));
  const capacityTotal = strata.reduce((sum, s) => sum + s.available, 0);
  const target = Math.min(Math.max(0, Math.floor(total)), capacityTotal);

  const floorSum = strata.reduce((sum, s) => sum + Math.min(s.quota, s.available), 0);
  let remaining = target;
  if (target >= floorSum) {
    for (const s of strata) selected.set(s.key, Math.min(s.quota, s.available));
    remaining = target - floorSum;
  }
  while (remaining > 0) {
    let progressed = false;
    for (const key of order) {
      if (remaining === 0) break;
      const s = byKey.get(key)!;
      if ((selected.get(key) ?? 0) < s.available) {
        selected.set(key, (selected.get(key) ?? 0) + 1);
        remaining -= 1;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return strata.map((s) => ({
    key: s.key,
    available: s.available,
    quota: s.quota,
    selected: selected.get(s.key) ?? 0,
    shortfall: Math.max(0, s.quota - s.available),
  }));
}

export interface StratifiedSample<T extends BankQuestion> {
  bank: GbtBank;
  requested: number;
  /** 实际抽到的题（按层、层内按种子顺序）。 */
  items: T[];
  strata: StratumAllocation[];
  /** 题库总量不够目标条数时的缺口。 */
  shortage: number;
  /** 题库里没有标注所属层的题（metadata 缺失），不参与抽样。 */
  unclassified: number;
  /** 偏向新题的配额：最近一次自动更新的版本、各层配额之和、实际抽到的新题数。 */
  fresh: { version: string | null; quota: number; selected: number };
}

/** 每层配额里最多这么多比例优先从最近一次自动更新新增的题里抽。 */
export const FRESH_QUESTION_RATIO = 0.3;

function strataFor(bank: GbtBank): { keys: readonly string[]; quota: (key: string) => number } {
  if (bank === 'generation') return { keys: ANNEX_ITEM_CODES, quota: generationItemQuota };
  if (bank === 'refusal') return { keys: REFUSAL_ITEM_CODES, quota: () => REFUSAL_ITEM_QUOTA };
  return { keys: NON_REFUSAL_ASPECTS, quota: () => NON_REFUSAL_ASPECT_QUOTA };
}

function stratumOf(bank: GbtBank, q: BankQuestion): string | null {
  return bank === 'non_refusal' ? q.aspect : q.annexItem;
}

/**
 * 按附录 B 的分层要求抽样：生成内容按 31 项，应拒答按 17 项，非拒答按 13 个方面。
 * `requested` 低于附录 B 下限时照样抽，报告里会因样本不足判「证据不足」。
 * 层内抽样沿用平台的固定种子不放回抽样，同种子同题库得到同一名单。
 */
export function sampleBank<T extends BankQuestion>(
  bank: GbtBank,
  questions: readonly T[],
  options: { requested?: number; seed: string; freshVersion?: string | null; freshRatio?: number },
): StratifiedSample<T> {
  const { keys, quota } = strataFor(bank);
  const known = new Set(keys);
  const groups = new Map<string, T[]>(keys.map((k) => [k, []]));
  let unclassified = 0;
  for (const q of questions) {
    const stratum = stratumOf(bank, q);
    if (!stratum || !known.has(stratum)) {
      unclassified += 1;
      continue;
    }
    groups.get(stratum)!.push(q);
  }
  const requested = options.requested ?? GBT_MIN_SAMPLES[bank];
  // 生成内容题：目标条数不得低于各项保底之和，否则每项抽不到题库要求的题数（1130 = 17×50 + 14×20）。
  const floorSum =
    bank === 'generation' ? keys.reduce((sum, key) => sum + quota(key), 0) : 0;
  const target = Math.max(requested, floorSum);
  const strata = allocateStrata(
    keys.map((key) => ({ key, available: groups.get(key)!.length, quota: quota(key) })),
    target,
    `${options.seed}:${bank}`,
  );
  const items: T[] = [];
  const freshVersion = options.freshVersion ?? null;
  const freshRatio = options.freshRatio ?? FRESH_QUESTION_RATIO;
  let freshQuota = 0;
  let freshSelected = 0;
  for (const s of strata) {
    if (s.selected === 0) continue;
    const pool = groups.get(s.key)!;
    const freshPool = freshVersion ? pool.filter((q) => q.addedInVersion === freshVersion) : [];
    const quota = Math.min(Math.floor(s.selected * freshRatio), freshPool.length);
    // 共享抽样函数要求带索引签名的候选类型，这里包一层再取回原对象。
    const wrap = (list: readonly T[]) => list.map((item) => ({ id: item.id, item }));
    if (quota === 0) {
      items.push(
        ...sampleStandardItems(wrap(pool), s.selected, `${options.seed}:${bank}:${s.key}`).map((w) => w.item),
      );
      continue;
    }
    // 最多 30% 优先取最近一次自动更新的新题（同样用种子洗牌，可复现），其余从旧题里照旧抽；旧题不够再用新题补。
    const fresh = sampleStandardItems(wrap(freshPool), quota, `${options.seed}:${bank}:${s.key}:fresh`).map((w) => w.item);
    const taken = new Set(fresh.map((q) => q.id));
    const old = pool.filter((q) => q.addedInVersion !== freshVersion);
    const needOld = s.selected - fresh.length;
    const oldPicked = sampleStandardItems(wrap(old), Math.min(needOld, old.length), `${options.seed}:${bank}:${s.key}`).map((w) => w.item);
    const picked = [...fresh, ...oldPicked];
    if (picked.length < s.selected) {
      const rest = freshPool.filter((q) => !taken.has(q.id));
      picked.push(
        ...sampleStandardItems(wrap(rest), s.selected - picked.length, `${options.seed}:${bank}:${s.key}:topup`).map((w) => w.item),
      );
    }
    freshQuota += quota;
    freshSelected += picked.filter((q) => q.addedInVersion === freshVersion).length;
    items.push(...picked);
  }
  return {
    bank,
    requested,
    items,
    strata,
    shortage: Math.max(0, requested - items.length),
    unclassified,
    fresh: { version: freshVersion, quota: freshQuota, selected: freshSelected },
  };
}
