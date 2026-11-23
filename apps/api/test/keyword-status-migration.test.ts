// 关键词状态改为「生效 / 候选 / 停用」的迁移：加状态修改人、修改时间两列；内置候选词改为生效，每周更新的候选词不动。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/db.js';

const migrationsUrl = new URL('../prisma/migrations/', import.meta.url);
const SUFFIX = '_keyword_status';
const TAG = `kwmig${randomUUID().slice(0, 6)}`;

async function migrationSql(): Promise<{ name: string; sql: string }> {
  const entries = await readdir(migrationsUrl, { withFileTypes: true });
  const dir = entries.find((e) => e.isDirectory() && e.name.endsWith(SUFFIX));
  assert.ok(dir, `缺少以 ${SUFFIX} 结尾的迁移`);
  return {
    name: dir.name,
    sql: await readFile(new URL(`${dir.name}/migration.sql`, migrationsUrl), 'utf8'),
  };
}

/** 去掉注释后按分号切出 UPDATE 语句。 */
function updates(sql: string): string[] {
  return sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => /^UPDATE\b/i.test(s));
}

after(async () => {
  await prisma.standardKeyword.deleteMany({ where: { term: { startsWith: TAG } } });
  await prisma.$disconnect();
});

test('迁移：时间戳在 20261122130000 段，只加两列可空列，不删列', async () => {
  const { name, sql } = await migrationSql();
  assert.match(name, /^2026112213\d{4}_/);
  assert.match(sql, /ADD COLUMN\s+"statusChangedAt"\s+TIMESTAMP\(3\)\s*[,;]/i);
  assert.match(sql, /ADD COLUMN\s+"statusChangedBy"\s+TEXT\s*[,;]/i);
  assert.doesNotMatch(sql, /DROP\s+(COLUMN|TABLE)/i);
  assert.doesNotMatch(sql, /NOT NULL/i);
  assert.match(sql, /"tenantId" IS NULL/, '只改平台词表');
});

test('迁移：内置候选词改为生效；每周更新、导入的候选词和停用、剔除的词都不动', async () => {
  const { sql } = await migrationSql();
  const stmts = updates(sql);
  assert.equal(stmts.length, 1);
  const ROLLBACK = new Error('rollback');
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      const mk = (
        suffix: string,
        source: string,
        reviewStatus: string,
        tenantId: string | null = null,
      ) => ({
        tenantId,
        itemCode: 'A.1.b',
        term: `${TAG}${suffix}`,
        source,
        reviewStatus,
      });
      await tx.standardKeyword.createMany({
        data: [
          mk('内置候选', 'builtin:gbt45654', 'pending'),
          mk('内置停用', 'builtin:gbt45654', 'disabled'),
          mk('内置剔除', 'builtin:gbt45654', 'rejected'),
          mk('每周候选', 'auto:weekly', 'pending'),
          mk('导入候选', 'import:txt', 'pending'),
        ],
      });
      const tenant = await tx.tenant.findFirst({
        where: { isPlatform: false },
        select: { id: true },
      });
      const platformTenant = await tx.tenant.findFirstOrThrow({
        where: { isPlatform: true },
        select: { id: true },
      });
      await tx.standardKeyword.create({
        data: mk(
          '租户名下内置候选',
          'builtin:gbt45654',
          'pending',
          tenant?.id ?? platformTenant.id,
        ),
      });
      for (const s of stmts) await tx.$executeRawUnsafe(s);
      const rows = await tx.standardKeyword.findMany({ where: { term: { startsWith: TAG } } });
      const status = Object.fromEntries(
        rows.map((r) => [r.term.slice(TAG.length), r.reviewStatus]),
      );
      assert.deepEqual(status, {
        内置候选: 'approved',
        内置停用: 'disabled',
        内置剔除: 'rejected',
        每周候选: 'pending',
        导入候选: 'pending',
        租户名下内置候选: 'pending',
      });
      // 迁移不是人工操作，不记修改人。
      assert.ok(rows.every((r) => r.statusChangedBy === null && r.statusChangedAt === null));
      throw ROLLBACK;
    }),
    (e) => e === ROLLBACK,
  );
});
