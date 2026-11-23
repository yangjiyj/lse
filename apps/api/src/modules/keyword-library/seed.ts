import type { PrismaClient } from '@prisma/client';
import {
  GBT45654_DATASET_DIR,
  loadManifest,
  parseJsonl,
  readVerified,
} from '../question-sets/builtin/gbt45654-bank.js';
import { AUTO_KEYWORD_SOURCE } from '../question-sets/bank-updates/constants.js';

const BUILTIN_SOURCE = 'builtin:gbt45654';

export interface KeywordSyncResult {
  total: number;
  added: number;
  /** 按版本对齐：数据集里已没有的内置词（生效、候选），标为已剔除；停用的不碰。 */
  rejected: number;
  /** 按版本对齐：新版本数据集里重新出现、此前被标为已剔除的内置词，恢复为生效。 */
  restored: number;
  /** 数据集里有、状态却是候选的内置词（如旧版本写入的），改为生效；停用的不碰。 */
  promoted: number;
  /** 每周补充的词被并进数据集：同名的每周更新词（候选、生效）改成内置来源并生效；停用的不碰。 */
  adopted: number;
  byItem: Record<string, number>;
}

interface KeywordRow {
  item: string;
  term: string;
}

const keyOf = (itemCode: string, term: string) => `${itemCode}\u0000${term}`;

/** 按 id 分批改。 */
async function updateByIds(
  db: PrismaClient,
  ids: string[],
  data: { reviewStatus: string; source?: string },
) {
  for (let i = 0; i < ids.length; i += 2000) {
    await db.standardKeyword.updateMany({ where: { id: { in: ids.slice(i, i + 2000) } }, data });
  }
}

/** 平台词表里某来源、某些状态的词中，在（或不在）数据集里的那些。 */
async function platformWords(db: PrismaClient, source: string, statuses: string[]) {
  return db.standardKeyword.findMany({
    where: { tenantId: null, source, reviewStatus: { in: statuses } },
    select: { id: true, itemCode: true, term: true },
  });
}

/**
 * 幂等写入平台内置关键词库（tenantId 为空）：内置词随版本发布即生效（reviewStatus=approved）。
 * 2026.11.4 起数据文件覆盖附录 A 31 项（含 A.1 a/b/c/e）。
 * 已存在的词不重复写入；人工停用（disabled）的词同步一律不碰。
 */
export async function syncBuiltinKeywords(
  db: PrismaClient,
  dir = GBT45654_DATASET_DIR,
): Promise<KeywordSyncResult> {
  const manifest = loadManifest(dir);
  const rows = parseJsonl<KeywordRow>(
    readVerified(manifest.keywords.file, manifest.keywords.sha256, dir),
  );
  const inDataset = new Set(rows.map((r) => keyOf(r.item, r.term)));
  const inSet = (k: { itemCode: string; term: string }) => inDataset.has(keyOf(k.itemCode, k.term));

  // 每周补充的词被并进数据集：把同名的那一行改成内置来源并生效，不再另补一条。
  const adopt = (await platformWords(db, AUTO_KEYWORD_SOURCE, ['pending', 'approved'])).filter(
    inSet,
  );
  await updateByIds(
    db,
    adopt.map((k) => k.id),
    { source: BUILTIN_SOURCE, reviewStatus: 'approved' },
  );
  // 数据集里有、仍是候选的内置词改为生效。
  const promote = (await platformWords(db, BUILTIN_SOURCE, ['pending'])).filter(inSet);
  await updateByIds(
    db,
    promote.map((k) => k.id),
    { reviewStatus: 'approved' },
  );

  const have = new Set(
    (
      await db.standardKeyword.findMany({
        where: { tenantId: null },
        select: { itemCode: true, term: true },
      })
    ).map((k) => keyOf(k.itemCode, k.term)),
  );
  const fresh = rows.filter((r) => !have.has(keyOf(r.item, r.term)));
  for (let i = 0; i < fresh.length; i += 2000) {
    await db.standardKeyword.createMany({
      data: fresh.slice(i, i + 2000).map((r) => ({
        tenantId: null,
        itemCode: r.item,
        term: r.term,
        source: BUILTIN_SOURCE,
        reviewStatus: 'approved',
      })),
      skipDuplicates: true,
    });
  }
  const byItem: Record<string, number> = {};
  for (const r of fresh) byItem[r.item] = (byItem[r.item] ?? 0) + 1;
  // 版本对齐：旧版本有、新版本没有的内置词（生效、候选）标为已剔除；停用的不碰。
  // 只对齐内置词：auto:weekly 自动补充的词不在数据文件里，不能剔除。
  const stale = (await platformWords(db, BUILTIN_SOURCE, ['approved', 'pending'])).filter(
    (k) => !inSet(k),
  );
  await updateByIds(
    db,
    stale.map((k) => k.id),
    { reviewStatus: 'rejected' },
  );
  const back = (await platformWords(db, BUILTIN_SOURCE, ['rejected'])).filter(inSet);
  await updateByIds(
    db,
    back.map((k) => k.id),
    { reviewStatus: 'approved' },
  );
  return {
    total: rows.length,
    added: fresh.length,
    rejected: stale.length,
    restored: back.length,
    promoted: promote.length,
    adopted: adopt.length,
    byItem,
  };
}
