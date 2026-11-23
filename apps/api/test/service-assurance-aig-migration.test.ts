import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Prisma } from '@prisma/client';
import test, { after, before } from 'node:test';
import { prisma } from '../src/db.js';
import {
  HISTORICAL_AIG_PARSE_ERROR_REASON,
  applyAigMigration,
  classifyLegacyAigFinding,
  collectAigReferenceAudit,
  previewAigMigration,
  previewAigRollback,
  requireAbsoluteReceiptPath,
  rollbackAigMigration,
} from '../scripts/service-assurance-migrate-aig.js';

const fixture = async (name: string): Promise<unknown> =>
  JSON.parse(
    await readFile(new URL(`./fixtures/service-assurance/${name}`, import.meta.url), 'utf8'),
  ) as unknown;

const prefix = `__service_assurance_aig_migration_${randomUUID()}_`;
const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const sentinel = 'task11-receipt-redaction-sentinel'; // pragma: allowlist secret
let taskId = '';
let targetId = '';
let findingId = '';
let untouchedFindingId = '';
let engineRunId = '';
let receiptDirectory = '';

test('迁移与回滚 CLI 拒绝相对 receipt 路径', () => {
  assert.equal(
    requireAbsoluteReceiptPath('/tmp/service-assurance-receipt.json'),
    '/tmp/service-assurance-receipt.json',
  );
  assert.throws(
    () => requireAbsoluteReceiptPath('relative-receipt.json'),
    /receipt 必须使用绝对路径/,
  );
});

before(async () => {
  receiptDirectory = await mkdtemp(join(tmpdir(), 'lse-sa-aig-migration-'));
  const target = await prisma.modelTarget.create({
    data: {
      name: `${prefix}target`,
      provider: 'openai-compatible',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'aig-migration-test-placeholder', // pragma: allowlist secret
      model: 'not-used',
    },
  });
  targetId = target.id;
  const task = await prisma.evalTask.create({
    data: {
      name: `${prefix}task`,
      modelTargetId: target.id,
      engines: ['ai-infra-guard'],
      dimensions: ['component_vulnerability'],
    },
  });
  taskId = task.id;
  const raw = await fixture('aig-historical-result-update.json');
  const finding = await prisma.finding.create({
    data: {
      taskId,
      engine: 'ai-infra-guard',
      riskCategory: 'component_vulnerability',
      severity: 'MEDIUM',
      verdict: 'FAIL',
      reviewStatus: 'UNREVIEWED',
      reviewReason: `历史复核 api_key=${sentinel}`,
      title: 'AI-Infra-Guard 风险 1',
      evidence: JSON.stringify(raw),
      detail: { v: 2, raw } as Prisma.InputJsonObject,
    },
  });
  findingId = finding.id;
  const untouched = await prisma.finding.create({
    data: {
      taskId,
      engine: 'ai-infra-guard',
      riskCategory: 'prompt_injection',
      severity: 'HIGH',
      verdict: 'FAIL',
      reviewStatus: 'NEEDS_REVIEW',
      title: '历史红队发现',
      evidence: '受控红队证据',
      detail: { v: 2, raw: { title: 'Prompt Leak' } },
    },
  });
  untouchedFindingId = untouched.id;
  const engineRun = await prisma.engineRun.create({
    data: {
      taskId,
      engine: 'ai-infra-guard',
      status: 'RUNNING',
      rawOutput: JSON.stringify({ raw, sentinel }),
      normalizedCount: 1,
    },
  });
  engineRunId = engineRun.id;
});

after(async () => {
  await prisma.serviceEvidence.deleteMany({ where: { run: { taskId } } });
  await prisma.vulnerabilityAssessment.deleteMany({ where: { run: { taskId } } });
  await prisma.serviceComponent.deleteMany({ where: { run: { taskId } } });
  await prisma.serviceAsset.deleteMany({ where: { run: { taskId } } });
  await prisma.serviceAssuranceRun.deleteMany({ where: { taskId } });
  await prisma.auditLog.deleteMany({
    where: {
      action: { startsWith: 'service_assurance.legacy_aig_' },
      targetId: findingId,
    },
  });
  await prisma.finding.deleteMany({ where: { taskId } });
  await prisma.engineRun.deleteMany({ where: { taskId } });
  await prisma.evalTask.deleteMany({ where: { id: taskId } });
  await prisma.modelTarget.deleteMany({ where: { id: targetId } });
  await prisma.$disconnect();
});

test('旧 resultUpdate 泛化风险降为误报并仅保留无版本组件线索', async () => {
  const action = classifyLegacyAigFinding({
    id: 'legacy-finding-1',
    engine: 'ai-infra-guard',
    riskCategory: 'component_vulnerability',
    title: 'AI-Infra-Guard 风险 1',
    evidence: '{}',
    reviewStatus: 'UNREVIEWED',
    reviewReason: null,
    detail: {
      v: 2,
      raw: await fixture('aig-historical-result-update.json'),
    },
  });

  assert.equal(action.kind, 'MIGRATE');
  assert.equal(action.reviewStatus, 'FALSE_POSITIVE');
  assert.equal(action.reviewReason, HISTORICAL_AIG_PARSE_ERROR_REASON);
  assert.deepEqual(action.lead, {
    componentName: 'NVIDIA Triton 推理服务',
    impactStatus: 'UNDER_INVESTIGATION',
    evidenceLevel: 'LEAD',
    reason: '历史扫描只识别到组件名称，未取得版本或验证证据。',
  });
  assert.doesNotMatch(JSON.stringify(action.lead), /CVE-2099-0001|32/);
});

test('普通旧红队 Finding 不属于组件误归一化迁移范围', () => {
  const action = classifyLegacyAigFinding({
    id: 'legacy-redteam-1',
    engine: 'ai-infra-guard',
    riskCategory: 'prompt_injection',
    title: 'Prompt Leak',
    evidence: '受控红队证据',
    reviewStatus: 'NEEDS_REVIEW',
    reviewReason: null,
    detail: { v: 2, raw: { title: 'Prompt Leak', severity: 'high' } },
  });

  assert.deepEqual(action, { kind: 'SKIP', reason: 'OUT_OF_SCOPE' });
});

test('已有组件版本的历史记录不自动降级或确认漏洞', () => {
  const action = classifyLegacyAigFinding({
    id: 'legacy-versioned-1',
    engine: 'ai-infra-guard',
    riskCategory: 'component_vulnerability',
    title: 'NVIDIA Triton Inference Server 2.50.0',
    evidence: 'version=2.50.0',
    reviewStatus: 'CONFIRMED',
    reviewReason: '历史人工确认',
    detail: {
      v: 2,
      raw: { component: 'NVIDIA Triton Inference Server', version: '2.50.0' },
    },
  });

  assert.deepEqual(action, { kind: 'SKIP', reason: 'VERSION_REQUIRES_MANUAL_REVIEW' });
});

test('预览、事务应用、幂等执行和回滚保留历史证据', async () => {
  const receiptPath = join(receiptDirectory, 'apply-receipt.json');
  const repeatReceiptPath = join(receiptDirectory, 'repeat-receipt.json');
  const rawBefore = await prisma.engineRun.findUniqueOrThrow({ where: { id: engineRunId } });
  const countsBefore = {
    engineRuns: await prisma.engineRun.count({ where: { taskId } }),
    findings: await prisma.finding.count({ where: { taskId } }),
    auditLogs: await prisma.auditLog.count(),
  };

  const preview = await previewAigMigration(prisma, { sourceRoot });
  assert.equal(preview.changeCount, 1);
  assert.equal(preview.leadCount, 1);
  assert.deepEqual(preview.skipReasonCounts, {
    OUT_OF_SCOPE: 1,
    ALREADY_MIGRATED: 0,
    VERSION_REQUIRES_MANUAL_REVIEW: 0,
  });
  assert.equal(preview.referenceAudit.configuredTaskCount, 1);
  assert.equal(preview.referenceAudit.activeEngineRunCount, 1);
  assert.equal(preview.referenceAudit.relayAuditImportCount, 0);
  await assert.rejects(readFile(receiptPath), { code: 'ENOENT' });
  assert.equal(
    (await prisma.finding.findUniqueOrThrow({ where: { id: findingId } })).reviewStatus,
    'UNREVIEWED',
  );

  const applied = await applyAigMigration(prisma, {
    sourceRoot,
    receiptPath,
    now: new Date('2026-08-31T01:00:00.000Z'),
  });
  assert.equal(applied.appliedCount, 1);
  assert.equal(applied.leadCount, 1);
  const migrated = await prisma.finding.findUniqueOrThrow({ where: { id: findingId } });
  assert.equal(migrated.reviewStatus, 'FALSE_POSITIVE');
  assert.equal(migrated.reviewReason, HISTORICAL_AIG_PARSE_ERROR_REASON);
  const untouched = await prisma.finding.findUniqueOrThrow({ where: { id: untouchedFindingId } });
  assert.equal(untouched.reviewStatus, 'NEEDS_REVIEW');
  const assessment = await prisma.vulnerabilityAssessment.findFirstOrThrow({
    where: { legacyFindingId: findingId },
    include: { component: true, run: true, evidence: true },
  });
  assert.equal(assessment.impactStatus, 'UNDER_INVESTIGATION');
  assert.equal(assessment.evidenceLevel, 'LEAD');
  assert.equal(assessment.severity, null);
  assert.equal(assessment.component?.name, 'NVIDIA Triton 推理服务');
  assert.equal(assessment.component?.version, null);
  assert.equal(assessment.run.status, 'PARTIAL');
  assert.equal(assessment.run.coverageStatus, 'INCOMPLETE');
  assert.equal(assessment.evidence.length, 1);
  assert.equal(assessment.findingId, null);

  const receiptText = await readFile(receiptPath, 'utf8');
  const receipt = JSON.parse(receiptText) as {
    state: string;
    payloadSha256: string;
    payload: { changes: Array<{ findingId: string; contentSha256: string }> };
  };
  assert.equal(receipt.state, 'APPLIED');
  assert.match(receipt.payloadSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    receipt.payload.changes.map((item) => item.findingId),
    [findingId],
  );
  assert.match(receipt.payload.changes[0]!.contentSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(receiptText, new RegExp(sentinel));
  assert.doesNotMatch(receiptText, /rawOutput|resultUpdate|CVE-2099-0001|gateway\.example/);
  const rollbackPreview = await previewAigRollback(prisma, { receiptPath });
  assert.deepEqual(rollbackPreview, { restorableCount: 1, conflictCount: 0 });

  const tamperedReceiptPath = join(receiptDirectory, 'tampered-receipt.json');
  const tampered = JSON.parse(receiptText) as {
    payload: { changes: Array<{ oldReviewStatus: string }> };
  };
  tampered.payload.changes[0]!.oldReviewStatus = 'CONFIRMED';
  await writeFile(tamperedReceiptPath, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
  await assert.rejects(
    rollbackAigMigration(prisma, {
      receiptPath: tamperedReceiptPath,
      rollbackReceiptPath: join(receiptDirectory, 'tampered-rollback.json'),
    }),
    /摘要校验失败/,
  );

  const runCountAfterApply = await prisma.serviceAssuranceRun.count({ where: { taskId } });
  const assessmentCountAfterApply = await prisma.vulnerabilityAssessment.count({
    where: { run: { taskId } },
  });
  const repeated = await applyAigMigration(prisma, {
    sourceRoot,
    receiptPath: repeatReceiptPath,
    now: new Date('2026-08-31T01:01:00.000Z'),
  });
  assert.equal(repeated.appliedCount, 0);
  assert.equal(repeated.leadCount, 0);
  assert.equal(await prisma.serviceAssuranceRun.count({ where: { taskId } }), runCountAfterApply);
  assert.equal(
    await prisma.vulnerabilityAssessment.count({ where: { run: { taskId } } }),
    assessmentCountAfterApply,
  );

  const rolledBack = await rollbackAigMigration(prisma, {
    receiptPath,
    rollbackReceiptPath: join(receiptDirectory, 'rollback-receipt.json'),
    now: new Date('2026-08-31T01:02:00.000Z'),
  });
  assert.equal(rolledBack.restoredCount, 1);
  const restored = await prisma.finding.findUniqueOrThrow({ where: { id: findingId } });
  assert.equal(restored.reviewStatus, 'UNREVIEWED');
  assert.match(restored.reviewReason ?? '', /^历史复核 api_key=hash:[a-f0-9]{12}$/);
  assert.doesNotMatch(restored.reviewReason ?? '', new RegExp(sentinel));
  assert.deepEqual(await previewAigRollback(prisma, { receiptPath }), {
    restorableCount: 0,
    conflictCount: 1,
  });
  assert.equal(
    await prisma.vulnerabilityAssessment.count({ where: { legacyFindingId: findingId } }),
    1,
  );

  const rawAfter = await prisma.engineRun.findUniqueOrThrow({ where: { id: engineRunId } });
  assert.equal(rawAfter.rawOutput, rawBefore.rawOutput);
  assert.equal(await prisma.engineRun.count({ where: { taskId } }), countsBefore.engineRuns);
  assert.equal(await prisma.finding.count({ where: { taskId } }), countsBefore.findings);
  assert.ok((await prisma.auditLog.count()) >= countsBefore.auditLogs + 2);

  await prisma.evalTask.update({ where: { id: taskId }, data: { engines: [] } });
  await prisma.engineRun.update({ where: { id: engineRunId }, data: { status: 'SUCCESS' } });
  const refreshedReferences = await collectAigReferenceAudit(prisma, { sourceRoot });
  assert.equal(refreshedReferences.configuredTaskCount, 0);
  assert.equal(refreshedReferences.activeEngineRunCount, 0);
  assert.ok(refreshedReferences.historicalEngineRunCount >= countsBefore.engineRuns);
  assert.ok(refreshedReferences.historicalFindingCount >= countsBefore.findings);
  assert.equal(refreshedReferences.relayAuditImportCount, 0);
});
