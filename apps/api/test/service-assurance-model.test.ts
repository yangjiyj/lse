import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const schemaUrl = new URL('../prisma/schema.prisma', import.meta.url);

test('Prisma 服务核验模型区分运行、资产、组件、判断和证据', async () => {
  const schema = await readFile(schemaUrl, 'utf8');

  for (const modelName of [
    'ServiceAssuranceRun',
    'ServiceAsset',
    'ServiceComponent',
    'VulnerabilityAssessment',
    'ServiceEvidence',
  ]) {
    assert.match(schema, new RegExp(`model ${modelName} \\{`));
  }

  assert.match(schema, /severity\s+Severity\?/);
  assert.match(schema, /impactStatus\s+AssuranceImpactStatus/);
  assert.match(schema, /evidenceLevel\s+AssuranceEvidenceLevel/);
  assert.match(schema, /priority\s+AssurancePriority/);
  assert.match(schema, /contentSha256\s+String/);
  assert.match(schema, /retestOfRunId\s+String\?/);
  assert.match(schema, /legacyFindingId\s+String\?/);
});

test('正式 Finding 与专用判断关联但历史 Finding 不被级联删除', async () => {
  const schema = await readFile(schemaUrl, 'utf8');

  assert.match(schema, /assuranceAssessment\s+VulnerabilityAssessment\?/);
  assert.match(
    schema,
    /finding\s+Finding\?[\s\S]+@relation\("AssuranceFinding"[\s\S]+onDelete:\s*SetNull/,
  );
  assert.match(
    schema,
    /legacyFinding\s+Finding\?[\s\S]+@relation\("AssuranceLegacyFinding"[\s\S]+onDelete:\s*SetNull/,
  );
});

test('正式 Finding 允许未知严重度且不再默认中危', async () => {
  const schema = await readFile(schemaUrl, 'utf8');
  const findingModel = /model Finding \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? '';

  assert.match(findingModel, /severity\s+Severity\?/);
  assert.doesNotMatch(findingModel, /severity\s+Severity\??\s+@default\(MEDIUM\)/);
});
