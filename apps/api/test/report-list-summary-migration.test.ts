import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const migrationsUrl = new URL('../prisma/migrations/', import.meta.url);
const migrationSuffix = '_add_report_list_summary';

async function migrationSql(): Promise<string> {
  const entries = await readdir(migrationsUrl, { withFileTypes: true });
  const migration = entries.find(
    (entry) => entry.isDirectory() && entry.name.endsWith(migrationSuffix),
  );
  assert.ok(migration, `missing migration ending with ${migrationSuffix}`);
  return readFile(new URL(`${migration.name}/migration.sql`, migrationsUrl), 'utf8');
}

test('listSummary 迁移新增可空 JSONB 并为历史报告回填轻量字段', async () => {
  const sql = await migrationSql();

  assert.match(sql, /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+"listSummary"\s+JSONB/i);
  assert.match(sql, /UPDATE\s+"reports"[\s\S]+jsonb_build_object/i);
  for (const field of [
    'kind',
    'headline',
    'metrics',
    'totalQuestions',
    'processedQuestions',
    'passedCount',
    'failedCount',
    'errorCount',
    'wrongAnswerCount',
    'evidenceFindingCount',
    'findingCount',
    'securityScore',
    'verdictDistribution',
    'severityDistribution',
    'explanationRun',
  ]) {
    assert.match(sql, new RegExp(`'${field}'`));
  }
});

test('历史回填不复制证据重字段，并以 listSummary IS NULL 保持幂等', async () => {
  const sql = await migrationSql();

  for (const forbidden of [
    'riskEvidencePortfolio',
    'riskItemsBySeverity',
    'wrongAnswerSamples',
    'findingSamples',
    'remediationItems',
    'agentTraceSamples',
    'redTeamSummary',
  ]) {
    assert.doesNotMatch(sql, new RegExp(forbidden, 'i'));
  }
  assert.match(sql, /"listSummary"\s+IS\s+NULL/i);
  assert.doesNotMatch(sql, /SET\s+"summary"|SET\s+"content"/i);
});

test('Prisma Report 模型声明可空 listSummary', async () => {
  const schema = await readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  const reportModel = schema.match(/model Report \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(reportModel, /listSummary\s+Json\?/);
});
