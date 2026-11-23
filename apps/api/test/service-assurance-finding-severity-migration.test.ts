import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../prisma/migrations/20260830110000_finding_nullable_severity/migration.sql',
  import.meta.url,
);

test('未知严重度迁移只移除 Finding 默认值和非空约束', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /ALTER TABLE "findings" ALTER COLUMN "severity" DROP DEFAULT/i);
  assert.match(sql, /ALTER TABLE "findings" ALTER COLUMN "severity" DROP NOT NULL/i);
  assert.doesNotMatch(sql, /UPDATE|DELETE|DROP\s+(?:TABLE|COLUMN|TYPE)/i);
  assert.doesNotMatch(sql, /engine_runs|service_evidence|vulnerability_assessments/i);
});
