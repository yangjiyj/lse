import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const migrationsUrl = new URL('../prisma/migrations/', import.meta.url);
const migrationSuffix = '_reclassify_automated_review_statuses';

async function migrationSql(): Promise<string> {
  const entries = await readdir(migrationsUrl, { withFileTypes: true });
  const migration = entries.find(
    (entry) => entry.isDirectory() && entry.name.endsWith(migrationSuffix),
  );
  assert.ok(migration, `missing migration ending with ${migrationSuffix}`);
  return readFile(new URL(`${migration.name}/migration.sql`, migrationsUrl), 'utf8');
}

test('历史自动 CONFIRMED/FALSE_POSITIVE 统一回到 NEEDS_REVIEW', async () => {
  const sql = await migrationSql();

  assert.match(sql, /UPDATE\s+"findings"[\s\S]+SET[\s\S]+"reviewStatus"\s*=\s*'NEEDS_REVIEW'/i);
  assert.match(sql, /WHERE\s+"reviewStatus"\s+IN\s*\(\s*'CONFIRMED'\s*,\s*'FALSE_POSITIVE'\s*\)/i);
  assert.doesNotMatch(
    sql,
    /UPDATE\s+"eval_results"|UPDATE\s+"reports"/i,
    '迁移不得回写冻结的结果或报告快照',
  );
});

test('迁移保留原理由、区分旧状态并安全处理 null', async () => {
  const sql = await migrationSql();

  assert.match(sql, /历史自动复核纠偏/);
  assert.match(sql, /不代表人工确认风险/);
  assert.match(sql, /不代表人工确认误报/);
  assert.match(sql, /原复核理由/);
  assert.doesNotMatch(
    sql,
    /原 (?:CONFIRMED|FALSE_POSITIVE) 状态/,
    '客户可见的历史提示不得暴露数据库枚举',
  );
  assert.match(sql, /NULLIF\s*\(\s*BTRIM\s*\(\s*"reviewReason"\s*\)/i);
  assert.match(sql, /ELSE\s+E?'\\n原复核理由：'\s*\|\|\s*"reviewReason"/i);
});

test('迁移具备二次执行不再改写的幂等门槛', async () => {
  const sql = await migrationSql();

  const updates = sql.match(/UPDATE\s+"findings"/gi) ?? [];
  assert.equal(updates.length, 1);
  assert.match(
    sql,
    /WHERE\s+"reviewStatus"\s+IN\s*\(\s*'CONFIRMED'\s*,\s*'FALSE_POSITIVE'\s*\)\s*;/i,
  );
});
