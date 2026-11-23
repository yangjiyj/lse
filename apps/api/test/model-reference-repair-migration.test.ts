import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../prisma/migrations/20260908100000_repair_deleted_model_references/migration.sql',
  import.meta.url,
);

test('正式升级迁移只清理两个策略中的已删除模型引用', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  for (const settingKey of ['redteam.config', 'agent_eval.config']) {
    assert.match(sql, new RegExp(`'${settingKey.replace('.', '\\.')}'`));
  }
  for (const field of [
    'gatewayTargetId',
    'attackerTargetId',
    'secondaryAttackerTargetId',
    'judgeTargetId',
  ]) {
    assert.match(sql, new RegExp(`'${field}'`));
  }
  assert.match(sql, /NOT EXISTS[\s\S]+FROM "model_targets"/);
  assert.match(sql, /cardinality\(orphaned\.cleared_fields\) > 0/);
  assert.match(sql, /system_setting\.repair_deleted_model_references/);
});

test('正式升级迁移保留业务与历史表，仅更新配置并追加审计', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /UPDATE "system_settings"/);
  assert.match(sql, /INSERT INTO "audit_logs"/);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(sql, /\bDROP\s+(?:TABLE|COLUMN|TYPE)\b/i);
  assert.doesNotMatch(
    sql,
    /UPDATE\s+"(?:model_targets|eval_tasks|eval_results|reports|licenses)"/i,
  );
});
