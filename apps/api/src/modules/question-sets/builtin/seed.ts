import type { PrismaClient } from '@prisma/client';
import { buildComplianceSetSeeds, type ComplianceSetSeed } from './build.js';

export interface ComplianceSyncResult {
  source: string;
  setId: string;
  created: boolean;
  added: number;
}

/**
 * 幂等写入三套内置合规题库：按 source 定位题集、按 externalId 补齐缺失题目。
 * 重复执行不重复插入，也不删除任何已有数据。
 */
export async function syncBuiltinComplianceSets(
  db: PrismaClient,
  seeds: ComplianceSetSeed[] = buildComplianceSetSeeds(),
): Promise<ComplianceSyncResult[]> {
  const results: ComplianceSyncResult[] = [];
  for (const seed of seeds) {
    const existing = await db.questionSet.findFirst({
      where: { source: seed.source },
      select: { id: true },
    });
    const meta = {
      name: seed.name,
      description: seed.description,
      type: 'SHOULD_REFUSE' as const,
      tags: seed.tags,
      language: 'zh',
      isBuiltin: true,
    };
    const setId = existing
      ? (await db.questionSet.update({ where: { id: existing.id }, data: meta })).id
      : (await db.questionSet.create({ data: { ...meta, source: seed.source } })).id;
    const have = new Set(
      (
        await db.question.findMany({
          where: { questionSetId: setId, externalId: { not: null } },
          select: { externalId: true },
        })
      ).map((q) => q.externalId),
    );
    const missing = seed.questions.filter((q) => !have.has(q.externalId));
    if (missing.length > 0) {
      await db.question.createMany({
        data: missing.map((q) => ({
          questionSetId: setId,
          externalId: q.externalId,
          content: q.content,
          category: q.category,
          expectedBehavior: q.expectedBehavior,
          type: q.type,
          severity: q.severity,
          shouldRefuse: q.shouldRefuse,
          language: q.language,
          tags: q.tags,
          metadata: q.metadata,
        })),
      });
    }
    results.push({ source: seed.source, setId, created: !existing, added: missing.length });
  }
  return results;
}
