import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { BANK_KINDS, BANK_SOURCES, type BankKind } from '@lse/shared';
import { compareVersions, maxVersion, parseVersion } from './versions.js';

type Db = PrismaClient | Prisma.TransactionClient;

const isRetired = (m: unknown): boolean =>
  Boolean(m && typeof m === 'object' && !Array.isArray(m) && (m as Record<string, unknown>).retired === true);
const metaOf = (m: unknown): Record<string, unknown> =>
  m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {};

/** 本轮自动更新入库、尚未生效的题（metadata.pendingVersion 有值）。抽样、覆盖统计、题量都当作不在用。 */
export function isPendingQuestion(m: unknown): boolean {
  const v = metaOf(m).pendingVersion;
  return typeof v === 'string' && v.length > 0;
}

/** 不在用：按版本对齐下线（retired）或尚未生效（pending）。 */
export const isInactiveQuestion = (m: unknown): boolean => isRetired(m) || isPendingQuestion(m);

/** 自动更新加入的题（内置题没有 addedInVersion）。 */
export const isAutoQuestion = (m: unknown): boolean => {
  const v = metaOf(m).addedInVersion;
  return typeof v === 'string' && v.length > 0;
};

/** 在用题的哈希：externalId 与内容按 externalId 排序后算 sha256。 */
export function activeQuestionsHash(rows: ReadonlyArray<{ externalId: string | null; content: string }>): string {
  const lines = rows.map((r) => `${r.externalId ?? ''}\t${r.content}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export interface BankSetRef {
  setId: string;
  bank: BankKind;
}

/**
 * 公用刷新函数：把题集 metadata 的 version、counts（重新统计在用题）、sha256（在用题哈希）刷新，
 * 其余字段（review、bank 等）保持不变。自动更新与发布 seed 都调用它。
 */
export async function refreshBankSetMetadata(
  db: Db,
  sets: readonly BankSetRef[],
  version: string,
): Promise<Record<string, { total: number; byItem?: Record<string, number>; byAspect?: Record<string, number> }>> {
  const out: Record<string, { total: number; byItem?: Record<string, number>; byAspect?: Record<string, number> }> = {};
  for (const { setId, bank } of sets) {
    const rows = await db.question.findMany({
      where: { questionSetId: setId },
      select: { externalId: true, content: true, metadata: true },
    });
    const active = rows.filter((r) => !isInactiveQuestion(r.metadata));
    const counts: { total: number; byItem?: Record<string, number>; byAspect?: Record<string, number> } = {
      total: active.length,
    };
    const by: Record<string, number> = {};
    for (const r of active) {
      const m = metaOf(r.metadata);
      const key = bank === 'non_refusal' ? m.aspect : m.annexItem;
      if (typeof key === 'string' && key) by[key] = (by[key] ?? 0) + 1;
    }
    if (bank === 'non_refusal') counts.byAspect = by;
    else counts.byItem = by;
    const set = await db.questionSet.findUnique({ where: { id: setId }, select: { metadata: true } });
    await db.questionSet.update({
      where: { id: setId },
      data: {
        metadata: {
          ...metaOf(set?.metadata),
          version,
          counts,
          /** 在用题里平台每月自动更新入库（单裁判核验）的题数，报告据此说明审校口径。 */
          autoCount: active.filter((r) => isAutoQuestion(r.metadata)).length,
          sha256: activeQuestionsHash(active),
        } as Prisma.InputJsonValue,
      },
    });
    out[bank] = counts;
  }
  return out;
}

/** 三个内置题集（按 source 定位，平台共享）。 */
export async function loadBuiltinBankSets(db: Db): Promise<Array<BankSetRef & { source: string }>> {
  const out: Array<BankSetRef & { source: string }> = [];
  for (const bank of BANK_KINDS) {
    const set = await db.questionSet.findFirst({
      where: { source: BANK_SOURCES[bank], tenantId: null },
      select: { id: true },
    });
    if (set) out.push({ setId: set.id, bank, source: BANK_SOURCES[bank] });
  }
  return out;
}

/** 最近一次成功的自动更新（定时或手动，不含随版本发布）的题库版本。 */
export async function latestAutoQuestionVersion(db: Db): Promise<string | null> {
  const rows = await db.gbtBankUpdate.findMany({
    where: { kind: 'questions', status: 'succeeded', trigger: { not: 'release' } },
    select: { version: true },
  });
  return maxVersion(rows.map((r) => r.version));
}

/** 题库版本：manifest 版本与最近一次成功的自动更新版本中较新的那个。 */
export async function effectiveQuestionVersion(db: Db, manifestVersion: string): Promise<string> {
  return maxVersion([manifestVersion, await latestSucceededQuestionVersion(db)]) ?? manifestVersion;
}

/** 已生效的最大题库版本：任何方式（自动更新、手动、随版本发布）成功的记录里最大的。 */
export async function latestSucceededQuestionVersion(db: Db): Promise<string | null> {
  const rows = await db.gbtBankUpdate.findMany({
    where: { kind: 'questions', status: 'succeeded' },
    select: { version: true },
  });
  return maxVersion(rows.map((r) => r.version));
}

/** 在已知版本上顺延一位：2026.12.3 → 2026.12.4。 */
export function bumpVersion(v: string): string {
  const p = parseVersion(v);
  if (!p) return v;
  return `${p[0]}.${String(p[1] ?? 1).padStart(2, '0')}.${(p[2] ?? 0) + 1}`;
}

/**
 * 本轮自动更新的失败收尾：把本轮（或遗留的）pending 题标下线，retiredBy=failed-update，seed 的恢复逻辑不会恢复它们。
 * version 为空时处理全部 pending 题（崩溃遗留）。返回下线题数。
 */
export async function retirePendingQuestions(db: Db, setIds: readonly string[], version?: string): Promise<number> {
  if (setIds.length === 0) return 0;
  const verSql = version ? Prisma.sql`AND "metadata"->>'pendingVersion' = ${version}` : Prisma.empty;
  const n = await db.$executeRaw`
    UPDATE "questions"
    SET "metadata" = ("metadata" - 'pendingVersion')
      || jsonb_build_object('retired', true, 'retiredBy', 'failed-update', 'retiredInVersion', COALESCE("metadata"->>'pendingVersion', ''))
    WHERE "questionSetId" IN (${Prisma.join([...setIds])})
      AND ("metadata"->>'pendingVersion') IS NOT NULL ${verSql}`;
  return Number(n);
}

/** 本轮成功：清掉 pending 标记，题目生效。 */
export async function activatePendingQuestions(db: Db, setIds: readonly string[], version: string): Promise<number> {
  if (setIds.length === 0) return 0;
  const n = await db.$executeRaw`
    UPDATE "questions" SET "metadata" = ("metadata" - 'pendingVersion')
    WHERE "questionSetId" IN (${Prisma.join([...setIds])}) AND "metadata"->>'pendingVersion' = ${version}`;
  return Number(n);
}

/** 题库版本写入锁的键：自动更新提交、发版 seed 定版本时在事务里拿同一把锁。 */
export const BANK_VERSION_LOCK_KEY = 45_654_2025;

/** 在事务里拿题库版本锁（事务结束自动释放），避免自动更新与发版 seed 交错导致版本倒退或撞号。 */
export async function lockBankVersion(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BANK_VERSION_LOCK_KEY}::bigint)`;
}

/** 当前已生效的最大题库版本：三个题集元数据与成功记录里最大的。 */
export async function currentBankVersion(db: Db): Promise<string | null> {
  const versions: Array<string | null> = [];
  for (const s of await loadBuiltinBankSets(db)) {
    const v = metaOf((await db.questionSet.findUnique({ where: { id: s.setId }, select: { metadata: true } }))?.metadata).version;
    versions.push(typeof v === 'string' ? v : null);
  }
  return maxVersion([...versions, await latestSucceededQuestionVersion(db)]);
}

/** 已用过的全部题库版本（任何状态的记录，加上调用方给的当前版本），用来算下一个版本号。 */
export async function knownQuestionVersions(db: Db, extra: ReadonlyArray<string | null | undefined> = []): Promise<string[]> {
  const rows = await db.gbtBankUpdate.findMany({
    where: { kind: 'questions' },
    select: { version: true },
  });
  return [...rows.map((r) => r.version), ...extra.filter((v): v is string => Boolean(v))];
}

/** 各内置题集在用题数。 */
export async function activeTotals(db: Db): Promise<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const s of await loadBuiltinBankSets(db)) {
    const rows = await db.question.findMany({ where: { questionSetId: s.setId }, select: { metadata: true } });
    totals[s.bank] = rows.filter((r) => !isInactiveQuestion(r.metadata)).length;
  }
  return totals;
}

/**
 * 发布 seed 用：manifest 的题库版本还没有 release 记录就补一条（随产品版本发布）；
 * manifest 版本不比已用过的最大题库版本新时不补（那个号已被自动更新或顺延版本超过，补了会出现一条更旧的发布记录）。
 * 关键词同理补一条 kind=keywords 的 release 记录（version 用 manifest.version）。幂等。
 */
export async function recordBankReleases(
  db: PrismaClient,
  manifest: { version: string; provenance?: { note?: string; [k: string]: unknown } },
  keywordTotal: number | null,
): Promise<{ questions: boolean; keywords: boolean }> {
  const now = new Date();
  const res = { questions: false, keywords: false };
  const hasQ = await db.gbtBankUpdate.findFirst({
    where: { kind: 'questions', trigger: 'release', version: manifest.version },
    select: { id: true },
  });
  const knownMax = maxVersion(await knownQuestionVersions(db));
  if (!hasQ && (knownMax === null || compareVersions(manifest.version, knownMax) > 0)) {
    await db.gbtBankUpdate.create({
      data: {
        kind: 'questions',
        version: manifest.version,
        trigger: 'release',
        status: 'succeeded',
        actorName: '版本发布',
        startedAt: now,
        finishedAt: now,
        totals: await activeTotals(db),
        note: manifest.provenance?.note || '随产品版本发布',
      },
    });
    res.questions = true;
  }
  const hasK = await db.gbtBankUpdate.findFirst({
    where: { kind: 'keywords', trigger: 'release', version: manifest.version },
    select: { id: true },
  });
  if (!hasK) {
    await db.gbtBankUpdate.create({
      data: {
        kind: 'keywords',
        version: manifest.version,
        trigger: 'release',
        status: 'succeeded',
        actorName: '版本发布',
        startedAt: now,
        finishedAt: now,
        totals: keywordTotal === null ? undefined : { keywords: keywordTotal },
        note: '随产品版本发布',
      },
    });
    res.keywords = true;
  }
  return res;
}
