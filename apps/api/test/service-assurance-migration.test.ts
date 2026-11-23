import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../prisma/migrations/20260830090000_service_assurance/migration.sql',
  import.meta.url,
);

test('服务核验迁移只新增专用结构并保留历史证据表', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  for (const enumName of [
    'ServiceAssuranceMode',
    'ServiceAssuranceTargetKind',
    'ServiceAssuranceRunStatus',
    'ServiceAssuranceCoverageStatus',
    'AssuranceImpactStatus',
    'AssuranceEvidenceLevel',
    'AssuranceEvidenceVisibility',
    'AssurancePriority',
  ]) {
    assert.match(sql, new RegExp(`CREATE TYPE "${enumName}" AS ENUM`));
  }

  for (const tableName of [
    'service_assurance_runs',
    'service_assets',
    'service_components',
    'vulnerability_assessments',
    'service_evidence',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE "${tableName}"`));
  }

  assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|TYPE)/i);
  assert.doesNotMatch(sql, /(?:UPDATE|DELETE\s+FROM)\s+"(?:engine_runs|findings|audit_logs)"/i);
  assert.doesNotMatch(sql, /ALTER\s+TABLE\s+"(?:engine_runs|audit_logs)"/i);
});

test('服务核验迁移通过限制型外键保留运行和判断证据', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /service_assurance_runs[\s\S]+eval_tasks[\s\S]+ON DELETE RESTRICT/i);
  assert.match(
    sql,
    /vulnerability_assessments[\s\S]+service_assurance_runs[\s\S]+ON DELETE RESTRICT/i,
  );
  assert.match(sql, /service_evidence[\s\S]+service_assurance_runs[\s\S]+ON DELETE RESTRICT/i);
});
