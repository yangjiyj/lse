import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FindingReviewStatus, Prisma, PrismaClient } from '@prisma/client';
import { redactString } from '../src/lib/redact.js';

export const HISTORICAL_AIG_PARSE_ERROR_REASON = '历史扫描结果解析错误';

const LEGACY_ENGINE = 'ai-infra-guard';
const LEGACY_COMPONENT_CATEGORY = 'component_vulnerability';
const TRITON_PATTERN = /\b(?:nvidia\s+)?triton(?:\s+inference\s+server)?\b/i;
const VERSION_KEY_PATTERN = /^(?:component[_-]?)?version$/i;
const MAX_VISITED_VALUES = 5_000;
const MAX_DEPTH = 8;

export interface LegacyAigFinding {
  id: string;
  engine: string;
  riskCategory: string;
  title: string | null;
  evidence: string | null;
  reviewStatus: string;
  reviewReason: string | null;
  detail: unknown;
}

export type LegacyAigSkipReason =
  | 'OUT_OF_SCOPE'
  | 'ALREADY_MIGRATED'
  | 'VERSION_REQUIRES_MANUAL_REVIEW';

export function requireAbsoluteReceiptPath(value: string | undefined): string {
  if (!value || !isAbsolute(value)) throw new Error('receipt 必须使用绝对路径');
  return value;
}

export type LegacyAigMigrationAction =
  | {
      kind: 'MIGRATE';
      reviewStatus: 'FALSE_POSITIVE';
      reviewReason: typeof HISTORICAL_AIG_PARSE_ERROR_REASON;
      lead: {
        componentName: 'NVIDIA Triton 推理服务';
        impactStatus: 'UNDER_INVESTIGATION';
        evidenceLevel: 'LEAD';
        reason: '历史扫描只识别到组件名称，未取得版本或验证证据。';
      } | null;
    }
  | {
      kind: 'SKIP';
      reason: LegacyAigSkipReason;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rawDetail(detail: unknown): unknown {
  const record = asRecord(detail);
  return record && 'raw' in record ? record.raw : detail;
}

function walkValues(
  root: unknown,
  visit: (key: string | null, value: unknown) => boolean,
): boolean {
  const queue: Array<{ key: string | null; value: unknown; depth: number }> = [
    { key: null, value: root, depth: 0 },
  ];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_VISITED_VALUES) {
    const current = queue.shift()!;
    visited += 1;
    if (visit(current.key, current.value)) return true;
    if (current.depth >= MAX_DEPTH) continue;
    if (Array.isArray(current.value)) {
      for (const value of current.value) {
        queue.push({ key: null, value, depth: current.depth + 1 });
      }
      continue;
    }
    const record = asRecord(current.value);
    if (!record) continue;
    for (const [key, value] of Object.entries(record)) {
      queue.push({ key, value, depth: current.depth + 1 });
    }
  }
  return false;
}

function hasExplicitVersion(raw: unknown, title: string | null, evidence: string | null): boolean {
  if (
    walkValues(
      raw,
      (key, value) =>
        key !== null &&
        VERSION_KEY_PATTERN.test(key) &&
        ((typeof value === 'string' && value.trim().length > 0) || typeof value === 'number'),
    )
  ) {
    return true;
  }
  const version = String.raw`v?\d+\.\d+(?:\.\d+)?`;
  const titleHasVersion = new RegExp(`\\btriton\\b[^\\n]{0,40}\\b${version}\\b`, 'i').test(
    title ?? '',
  );
  const evidenceHasVersion = new RegExp(`\\bversion\\s*[:=]\\s*${version}\\b`, 'i').test(
    evidence ?? '',
  );
  return titleHasVersion || evidenceHasVersion;
}

function isHistoricalResultUpdate(raw: unknown): boolean {
  const root = asRecord(raw);
  if (!root) return false;
  if (typeof root.event === 'string' && root.event.toLowerCase() === 'resultupdate') return true;
  const result = asRecord(root.result);
  const results = result ? asRecord(result.results) : null;
  return results !== null && Array.isArray(results.vulnerabilities);
}

function containsTritonName(raw: unknown, title: string | null): boolean {
  if (title && TRITON_PATTERN.test(title)) return true;
  return walkValues(
    raw,
    (key, value) =>
      typeof value === 'string' &&
      value.length <= 240 &&
      (key === 'name' || key === 'title' || key === 'component' || key === 'product') &&
      TRITON_PATTERN.test(value),
  );
}

export function classifyLegacyAigFinding(finding: LegacyAigFinding): LegacyAigMigrationAction {
  if (finding.engine !== LEGACY_ENGINE) return { kind: 'SKIP', reason: 'OUT_OF_SCOPE' };
  if (
    finding.reviewStatus === 'FALSE_POSITIVE' &&
    finding.reviewReason === HISTORICAL_AIG_PARSE_ERROR_REASON
  ) {
    return { kind: 'SKIP', reason: 'ALREADY_MIGRATED' };
  }

  const raw = rawDetail(finding.detail);
  const historicalEnvelope = isHistoricalResultUpdate(raw);
  const componentFinding = finding.riskCategory === LEGACY_COMPONENT_CATEGORY;
  if (!historicalEnvelope && !componentFinding) return { kind: 'SKIP', reason: 'OUT_OF_SCOPE' };
  if (hasExplicitVersion(raw, finding.title, finding.evidence)) {
    return { kind: 'SKIP', reason: 'VERSION_REQUIRES_MANUAL_REVIEW' };
  }

  return {
    kind: 'MIGRATE',
    reviewStatus: 'FALSE_POSITIVE',
    reviewReason: HISTORICAL_AIG_PARSE_ERROR_REASON,
    lead: containsTritonName(raw, finding.title)
      ? {
          componentName: 'NVIDIA Triton 推理服务',
          impactStatus: 'UNDER_INVESTIGATION',
          evidenceLevel: 'LEAD',
          reason: '历史扫描只识别到组件名称，未取得版本或验证证据。',
        }
      : null,
  };
}

const RECEIPT_SCHEMA_VERSION = 1;
const MAX_RECEIPT_BYTES = 1_048_576;
const MIGRATION_AUDIT_ACTION = 'service_assurance.legacy_aig_migration';
const ROLLBACK_AUDIT_ACTION = 'service_assurance.legacy_aig_rollback';
const REVIEW_STATUSES = new Set<FindingReviewStatus>([
  'UNREVIEWED',
  'NEEDS_REVIEW',
  'CONFIRMED',
  'FALSE_POSITIVE',
  'ACCEPTED_RISK',
]);

interface PlannedAigChange {
  findingId: string;
  taskId: string;
  oldReviewStatus: FindingReviewStatus;
  oldReviewReason: string | null;
  newReviewStatus: 'FALSE_POSITIVE';
  newReviewReason: typeof HISTORICAL_AIG_PARSE_ERROR_REASON;
  contentSha256: string;
  lead: LegacyAigMigrationAction extends infer Action
    ? Action extends { kind: 'MIGRATE'; lead: infer Lead }
      ? Lead
      : never
    : never;
}

export interface AigReferenceAudit {
  checkedAt: string;
  configuredTaskCount: number;
  activeEngineRunCount: number;
  historicalEngineRunCount: number;
  historicalFindingCount: number;
  relayAuditImportCount: number;
  hasBlockingReferences: boolean;
}

export interface AigMigrationPreview {
  mode: 'PREVIEW';
  changeCount: number;
  leadCount: number;
  skippedCount: number;
  skipReasonCounts: Record<LegacyAigSkipReason, number>;
  referenceAudit: AigReferenceAudit;
  changes: PlannedAigChange[];
}

interface MigrationReceiptPayload {
  operationId: string;
  transactionAt: string;
  referenceAudit: AigReferenceAudit;
  changes: PlannedAigChange[];
}

interface MigrationReceipt {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  state: 'PREPARED' | 'APPLIED' | 'FAILED';
  payloadSha256: string;
  payload: MigrationReceiptPayload;
  failureCode?: 'TRANSACTION_FAILED';
}

interface RollbackReceiptPayload {
  operationId: string;
  rollbackAt: string;
  migrationPayloadSha256: string;
  restoredFindingIds: string[];
  conflictedFindingIds: string[];
}

interface RollbackReceipt {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  state: 'PREPARED' | 'APPLIED' | 'FAILED';
  payloadSha256: string;
  payload: RollbackReceiptPayload;
  failureCode?: 'TRANSACTION_FAILED';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableUuid(...parts: string[]): string {
  const bytes = createHash('sha256').update(parts.join('\0')).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function findingContentDigest(finding: LegacyAigFinding): string {
  return sha256(
    JSON.stringify([
      finding.id,
      finding.engine,
      finding.riskCategory,
      finding.title,
      finding.evidence,
      finding.detail,
    ]),
  );
}

function receiptSafeChange(change: PlannedAigChange): PlannedAigChange {
  return {
    ...change,
    oldReviewReason:
      change.oldReviewReason === null ? null : redactString(change.oldReviewReason, 'reviewReason'),
  };
}

async function sourceImportCount(sourceRoot: string): Promise<number> {
  const relayPath = resolve(sourceRoot, 'apps/api/src/modules/engines/relay-audit.ts');
  const source = await readFile(relayPath, 'utf8');
  return source
    .split('\n')
    .filter((line) => /from\s+['"][^'"]*ai-infra-guard(?:\/[^'"]*)?['"]/.test(line)).length;
}

export async function collectAigReferenceAudit(
  db: PrismaClient,
  options: { sourceRoot: string; now?: Date },
): Promise<AigReferenceAudit> {
  const [
    configuredTaskCount,
    activeEngineRunCount,
    historicalEngineRunCount,
    historicalFindingCount,
    relayAuditImportCount,
  ] = await Promise.all([
    db.evalTask.count({ where: { engines: { has: LEGACY_ENGINE } } }),
    db.engineRun.count({
      where: { engine: LEGACY_ENGINE, status: { in: ['PENDING', 'RUNNING'] } },
    }),
    db.engineRun.count({ where: { engine: LEGACY_ENGINE } }),
    db.finding.count({ where: { engine: LEGACY_ENGINE } }),
    sourceImportCount(options.sourceRoot),
  ]);
  return {
    checkedAt: (options.now ?? new Date()).toISOString(),
    configuredTaskCount,
    activeEngineRunCount,
    historicalEngineRunCount,
    historicalFindingCount,
    relayAuditImportCount,
    hasBlockingReferences:
      configuredTaskCount > 0 || activeEngineRunCount > 0 || relayAuditImportCount > 0,
  };
}

export async function previewAigMigration(
  db: PrismaClient,
  options: { sourceRoot: string; now?: Date },
): Promise<AigMigrationPreview> {
  const [rows, referenceAudit] = await Promise.all([
    db.finding.findMany({
      where: { engine: LEGACY_ENGINE },
      select: {
        id: true,
        taskId: true,
        engine: true,
        riskCategory: true,
        title: true,
        evidence: true,
        reviewStatus: true,
        reviewReason: true,
        detail: true,
      },
      orderBy: { id: 'asc' },
    }),
    collectAigReferenceAudit(db, options),
  ]);
  const changes: PlannedAigChange[] = [];
  let skippedCount = 0;
  const skipReasonCounts: Record<LegacyAigSkipReason, number> = {
    OUT_OF_SCOPE: 0,
    ALREADY_MIGRATED: 0,
    VERSION_REQUIRES_MANUAL_REVIEW: 0,
  };
  for (const row of rows) {
    const action = classifyLegacyAigFinding(row);
    if (action.kind === 'SKIP') {
      skippedCount += 1;
      skipReasonCounts[action.reason] += 1;
      continue;
    }
    changes.push({
      findingId: row.id,
      taskId: row.taskId,
      oldReviewStatus: row.reviewStatus,
      oldReviewReason: row.reviewReason,
      newReviewStatus: action.reviewStatus,
      newReviewReason: action.reviewReason,
      contentSha256: findingContentDigest(row),
      lead: action.lead,
    });
  }
  return {
    mode: 'PREVIEW',
    changeCount: changes.length,
    leadCount: changes.filter((change) => change.lead !== null).length,
    skippedCount,
    skipReasonCounts,
    referenceAudit,
    changes,
  };
}

async function writeJsonExclusive(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeJsonExclusive(temporaryPath, value);
  await rename(temporaryPath, path);
}

function migrationReceipt(
  state: MigrationReceipt['state'],
  payload: MigrationReceiptPayload,
  failureCode?: MigrationReceipt['failureCode'],
): MigrationReceipt {
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    state,
    payloadSha256: sha256(JSON.stringify(payload)),
    payload,
    ...(failureCode ? { failureCode } : {}),
  };
}

function rollbackReceipt(
  state: RollbackReceipt['state'],
  payload: RollbackReceiptPayload,
  failureCode?: RollbackReceipt['failureCode'],
): RollbackReceipt {
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    state,
    payloadSha256: sha256(JSON.stringify(payload)),
    payload,
    ...(failureCode ? { failureCode } : {}),
  };
}

async function persistLead(
  tx: Prisma.TransactionClient,
  change: PlannedAigChange,
  transactionAt: Date,
): Promise<void> {
  if (!change.lead) return;
  const runId = stableUuid('legacy-aig-migration-run', change.taskId);
  const componentKey = `legacy-aig:${sha256(`${change.taskId}\0${change.lead.componentName}`).slice(0, 32)}`;
  const assessmentKey = `legacy-aig:${change.findingId}`;
  const evidenceDigest = sha256(
    ['legacy-aig-component-name', change.findingId, change.contentSha256].join('\0'),
  );
  await tx.serviceAssuranceRun.upsert({
    where: { id: runId },
    create: {
      id: runId,
      taskId: change.taskId,
      mode: 'SAFE',
      targetKind: 'ENDPOINT',
      targetName: '历史组件线索',
      normalizedTarget: null,
      scopePolicyRef: 'historical-aig-migration',
      authorizationConfirmed: false,
      status: 'PARTIAL',
      coverageStatus: 'INCOMPLETE',
      failureCode: 'HISTORICAL_EVIDENCE_LIMITED',
      failureMessage: '历史扫描证据不完整，仅保留待核验线索。',
      requestBudget: { maxRequests: 0, source: 'historical-migration' },
      engineVersions: { legacySource: LEGACY_ENGINE },
      startedAt: transactionAt,
      endedAt: transactionAt,
    },
    update: {},
  });
  const component = await tx.serviceComponent.upsert({
    where: { runId_componentKey: { runId, componentKey } },
    create: {
      runId,
      name: change.lead.componentName,
      version: null,
      source: 'historical-component-name',
      confidence: null,
      evidenceLevel: change.lead.evidenceLevel,
      componentKey,
    },
    update: {},
    select: { id: true },
  });
  const assessment = await tx.vulnerabilityAssessment.upsert({
    where: { runId_assessmentKey: { runId, assessmentKey } },
    create: {
      runId,
      componentId: component.id,
      advisoryId: null,
      title: '疑似组件、待核验线索',
      severity: null,
      impactStatus: change.lead.impactStatus,
      evidenceLevel: change.lead.evidenceLevel,
      confidence: null,
      priority: 'UNKNOWN',
      reason: change.lead.reason,
      remediation: '请补充组件版本或执行经授权的安全核验。',
      legacyFindingId: change.findingId,
      assessmentKey,
      decidedAt: transactionAt,
    },
    update: {},
    select: { id: true },
  });
  await tx.serviceEvidence.upsert({
    where: {
      runId_contentSha256_evidenceType: {
        runId,
        contentSha256: evidenceDigest,
        evidenceType: 'HISTORICAL_COMPONENT_NAME',
      },
    },
    create: {
      runId,
      assessmentId: assessment.id,
      componentId: component.id,
      evidenceType: 'HISTORICAL_COMPONENT_NAME',
      sourceTool: 'legacy-import',
      ruleSummary: '历史扫描仅提供组件名称，未提供版本或主动验证证据。',
      customerSummary: change.lead.reason,
      contentSha256: evidenceDigest,
      visibility: 'CUSTOMER',
    },
    update: {},
  });
}

export async function applyAigMigration(
  db: PrismaClient,
  options: { sourceRoot: string; receiptPath: string; now?: Date },
): Promise<{ appliedCount: number; leadCount: number; receiptPath: string }> {
  if (!isAbsolute(options.receiptPath)) throw new Error('receipt 必须使用绝对路径');
  const transactionAt = options.now ?? new Date();
  const preview = await previewAigMigration(db, {
    sourceRoot: options.sourceRoot,
    now: transactionAt,
  });
  const payload: MigrationReceiptPayload = {
    operationId: randomUUID(),
    transactionAt: transactionAt.toISOString(),
    referenceAudit: preview.referenceAudit,
    changes: preview.changes.map(receiptSafeChange),
  };
  await writeJsonExclusive(options.receiptPath, migrationReceipt('PREPARED', payload));
  try {
    await db.$transaction(async (tx) => {
      for (const change of preview.changes) {
        const updated = await tx.finding.updateMany({
          where: {
            id: change.findingId,
            engine: LEGACY_ENGINE,
            reviewStatus: change.oldReviewStatus,
            reviewReason: change.oldReviewReason,
          },
          data: {
            reviewStatus: change.newReviewStatus,
            reviewReason: change.newReviewReason,
          },
        });
        if (updated.count !== 1) throw new Error('AIG_MIGRATION_CONCURRENT_CHANGE');
        await persistLead(tx, change, transactionAt);
        await tx.auditLog.create({
          data: {
            action: MIGRATION_AUDIT_ACTION,
            targetType: 'finding',
            targetId: change.findingId,
            detail: {
              operationId: payload.operationId,
              contentSha256: change.contentSha256,
              oldReviewStatus: change.oldReviewStatus,
              newReviewStatus: change.newReviewStatus,
              leadCreated: change.lead !== null,
            },
          },
        });
      }
    });
  } catch (error) {
    await replaceJsonAtomically(
      options.receiptPath,
      migrationReceipt('FAILED', payload, 'TRANSACTION_FAILED'),
    );
    throw error;
  }
  await replaceJsonAtomically(options.receiptPath, migrationReceipt('APPLIED', payload));
  return {
    appliedCount: preview.changes.length,
    leadCount: preview.changes.filter((change) => change.lead !== null).length,
    receiptPath: options.receiptPath,
  };
}

function isMigrationReceipt(value: unknown): value is MigrationReceipt {
  const receipt = asRecord(value);
  const payload = receipt ? asRecord(receipt.payload) : null;
  if (
    !receipt ||
    receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    receipt.state !== 'APPLIED' ||
    typeof receipt.payloadSha256 !== 'string' ||
    !payload ||
    typeof payload.operationId !== 'string' ||
    typeof payload.transactionAt !== 'string' ||
    !Array.isArray(payload.changes)
  ) {
    return false;
  }
  if (payload.changes.length > 100_000) return false;
  return payload.changes.every((item) => {
    const change = asRecord(item);
    return (
      change !== null &&
      typeof change.findingId === 'string' &&
      typeof change.taskId === 'string' &&
      typeof change.contentSha256 === 'string' &&
      typeof change.oldReviewStatus === 'string' &&
      REVIEW_STATUSES.has(change.oldReviewStatus as FindingReviewStatus) &&
      (change.oldReviewReason === null || typeof change.oldReviewReason === 'string') &&
      change.newReviewStatus === 'FALSE_POSITIVE' &&
      change.newReviewReason === HISTORICAL_AIG_PARSE_ERROR_REASON
    );
  });
}

async function readVerifiedMigrationReceipt(path: string): Promise<MigrationReceipt> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_RECEIPT_BYTES) {
    throw new Error('迁移 receipt 不是受支持的普通文件');
  }
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!isMigrationReceipt(parsed)) throw new Error('迁移 receipt 结构或状态无效');
  if (sha256(JSON.stringify(parsed.payload)) !== parsed.payloadSha256) {
    throw new Error('迁移 receipt 摘要校验失败');
  }
  return parsed;
}

export async function previewAigRollback(
  db: PrismaClient,
  options: { receiptPath: string },
): Promise<{ restorableCount: number; conflictCount: number }> {
  if (!isAbsolute(options.receiptPath)) throw new Error('receipt 必须使用绝对路径');
  const migration = await readVerifiedMigrationReceipt(options.receiptPath);
  const rows = await db.finding.findMany({
    where: { id: { in: migration.payload.changes.map((change) => change.findingId) } },
    select: { id: true, engine: true, reviewStatus: true, reviewReason: true },
  });
  const current = new Map(rows.map((row) => [row.id, row]));
  let restorableCount = 0;
  for (const change of migration.payload.changes) {
    const row = current.get(change.findingId);
    if (
      row?.engine === LEGACY_ENGINE &&
      row.reviewStatus === change.newReviewStatus &&
      row.reviewReason === change.newReviewReason
    ) {
      restorableCount += 1;
    }
  }
  return {
    restorableCount,
    conflictCount: migration.payload.changes.length - restorableCount,
  };
}

export async function rollbackAigMigration(
  db: PrismaClient,
  options: {
    receiptPath: string;
    rollbackReceiptPath: string;
    now?: Date;
  },
): Promise<{ restoredCount: number; conflictCount: number; rollbackReceiptPath: string }> {
  if (!isAbsolute(options.receiptPath) || !isAbsolute(options.rollbackReceiptPath)) {
    throw new Error('receipt 必须使用绝对路径');
  }
  const migration = await readVerifiedMigrationReceipt(options.receiptPath);
  const rollbackAt = options.now ?? new Date();
  const payload: RollbackReceiptPayload = {
    operationId: randomUUID(),
    rollbackAt: rollbackAt.toISOString(),
    migrationPayloadSha256: migration.payloadSha256,
    restoredFindingIds: [],
    conflictedFindingIds: [],
  };
  await writeJsonExclusive(options.rollbackReceiptPath, rollbackReceipt('PREPARED', payload));
  try {
    await db.$transaction(async (tx) => {
      for (const change of migration.payload.changes) {
        const restored = await tx.finding.updateMany({
          where: {
            id: change.findingId,
            engine: LEGACY_ENGINE,
            reviewStatus: change.newReviewStatus,
            reviewReason: change.newReviewReason,
          },
          data: {
            reviewStatus: change.oldReviewStatus,
            reviewReason: change.oldReviewReason,
          },
        });
        if (restored.count === 0) {
          payload.conflictedFindingIds.push(change.findingId);
          continue;
        }
        payload.restoredFindingIds.push(change.findingId);
        await tx.auditLog.create({
          data: {
            action: ROLLBACK_AUDIT_ACTION,
            targetType: 'finding',
            targetId: change.findingId,
            detail: {
              operationId: payload.operationId,
              migrationPayloadSha256: migration.payloadSha256,
              restoredReviewStatus: change.oldReviewStatus,
            },
          },
        });
      }
    });
  } catch (error) {
    await replaceJsonAtomically(
      options.rollbackReceiptPath,
      rollbackReceipt('FAILED', payload, 'TRANSACTION_FAILED'),
    );
    throw error;
  }
  await replaceJsonAtomically(options.rollbackReceiptPath, rollbackReceipt('APPLIED', payload));
  return {
    restoredCount: payload.restoredFindingIds.length,
    conflictCount: payload.conflictedFindingIds.length,
    rollbackReceiptPath: options.rollbackReceiptPath,
  };
}

interface CliOptions {
  mode: 'PREVIEW' | 'APPLY';
  receiptPath: string | null;
  sourceRoot: string;
}

function parseCliOptions(argv: string[]): CliOptions {
  let mode: CliOptions['mode'] = 'PREVIEW';
  let receiptPath: string | null = null;
  let sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--preview') mode = 'PREVIEW';
    else if (arg === '--apply') mode = 'APPLY';
    else if (arg === '--receipt') receiptPath = requireAbsoluteReceiptPath(argv[++index]);
    else if (arg === '--source-root') sourceRoot = resolve(argv[++index] ?? '');
    else throw new Error(`不支持的参数：${arg}`);
  }
  if (mode === 'APPLY' && !receiptPath)
    throw new Error('--apply 必须同时提供 --receipt <绝对路径>');
  return { mode, receiptPath, sourceRoot };
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  await import('../src/env.js');
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  try {
    if (options.mode === 'PREVIEW') {
      const preview = await previewAigMigration(db, { sourceRoot: options.sourceRoot });
      console.log(
        JSON.stringify(
          {
            mode: preview.mode,
            changeCount: preview.changeCount,
            leadCount: preview.leadCount,
            skippedCount: preview.skippedCount,
            skipReasonCounts: preview.skipReasonCounts,
            referenceAudit: preview.referenceAudit,
          },
          null,
          2,
        ),
      );
      return;
    }
    const result = await applyAigMigration(db, {
      sourceRoot: options.sourceRoot,
      receiptPath: options.receiptPath!,
    });
    console.log(JSON.stringify({ mode: 'APPLY', ...result }, null, 2));
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : '迁移执行失败');
    process.exitCode = 1;
  });
}
