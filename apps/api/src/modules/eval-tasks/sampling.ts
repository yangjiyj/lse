import type { Prisma, PrismaClient } from '@prisma/client';
import { makeRng } from '../generator/core/prng.js';

export { MAX_SAMPLE_SIZE } from '@lse/shared';

export interface SampleCandidate {
  id: string;
  category: string | null;
}

/**
 * 按分类分层抽样（纯函数，可复现）：
 * - 每个分类按题量占比分配名额（最大余数法），保证每个非空分类至少 1 题（名额够时）；
 * - 分类内用种子洗牌后取前 k 个；结果按原始顺序返回。
 */
export function stratifiedSample<T extends SampleCandidate>(
  items: readonly T[],
  size: number,
  seed: string,
): T[] {
  if (size >= items.length) return [...items];
  if (size <= 0) return [];
  const groups = new Map<string, number[]>();
  items.forEach((q, i) => {
    const key = q.category ?? '';
    const list = groups.get(key) ?? [];
    list.push(i);
    groups.set(key, list);
  });
  const keys = [...groups.keys()].sort();
  const total = items.length;
  const quota = new Map<string, number>();
  let assigned = 0;
  const remainders: { key: string; r: number }[] = [];
  for (const key of keys) {
    const exact = (groups.get(key)!.length * size) / total;
    const base = Math.floor(exact);
    quota.set(key, base);
    assigned += base;
    remainders.push({ key, r: exact - base });
  }
  remainders.sort((a, b) => b.r - a.r || a.key.localeCompare(b.key));
  for (let i = 0; assigned < size && i < remainders.length; i++, assigned++) {
    const k = remainders[i]!.key;
    quota.set(k, quota.get(k)! + 1);
  }
  // 名额足够时，每个分类至少 1 题：从名额最多的分类挪。
  if (size >= keys.length) {
    for (const key of keys) {
      if (quota.get(key)! > 0) continue;
      const donor = keys.reduce((a, b) => (quota.get(b)! > quota.get(a)! ? b : a));
      quota.set(donor, quota.get(donor)! - 1);
      quota.set(key, 1);
    }
  }
  const picked: number[] = [];
  for (const key of keys) {
    const rng = makeRng(`${seed}|${key}`);
    picked.push(...rng.shuffle(groups.get(key)!).slice(0, quota.get(key)!));
  }
  return picked.sort((a, b) => a - b).map((i) => items[i]!);
}

type Db = Pick<PrismaClient, 'question'>;

const ORDER: Prisma.QuestionOrderByWithRelationInput[] = [{ createdAt: 'asc' }, { id: 'asc' }];

/**
 * 取某任务要跑的题目：未设置抽样时全量；设置了则先只取 id/category 做分层抽样，
 * 再按 id 分块加载完整题目，避免把 10 万级题库整表读入内存。
 * pinnedQuestionIds 非空（失败用例复测的显式题目冻结）：只取这些题，且仍限定在关联样本库内
 * 防越权，跳过抽样；为空/未传时行为与原来完全一致。
 */
export async function loadTaskQuestions(
  db: Db,
  setIds: string[],
  sampleSize: number | null | undefined,
  sampleSeed: string | null | undefined,
  pinnedQuestionIds?: string[] | null,
) {
  if (setIds.length === 0) return [];
  const where = { questionSetId: { in: setIds } };
  if (pinnedQuestionIds && pinnedQuestionIds.length > 0) {
    const ids = [...new Set(pinnedQuestionIds)];
    const rows = [];
    for (let i = 0; i < ids.length; i += 1000) {
      rows.push(
        ...(await db.question.findMany({
          where: { ...where, id: { in: ids.slice(i, i + 1000) } },
          orderBy: ORDER,
        })),
      );
    }
    return rows;
  }
  // 全量路径保持原有排序参数不变（与既有执行器行为一致）。
  if (!sampleSize) return db.question.findMany({ where, orderBy: { createdAt: 'asc' } });
  const candidates = await db.question.findMany({
    where,
    select: { id: true, category: true },
    orderBy: ORDER,
  });
  const chosen = stratifiedSample(candidates, sampleSize, sampleSeed ?? 'lse-sample');
  const order = new Map(chosen.map((c, i) => [c.id, i]));
  const rows = [];
  for (let i = 0; i < chosen.length; i += 1000) {
    const ids = chosen.slice(i, i + 1000).map((c) => c.id);
    rows.push(...(await db.question.findMany({ where: { id: { in: ids } } })));
  }
  return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

/** 抽样后的实际题数（任务创建时用于展示 totalQuestions）。 */
export function sampledTotal(total: number, sampleSize: number | null | undefined): number {
  return sampleSize ? Math.min(total, sampleSize) : total;
}
