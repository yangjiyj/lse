import {
  DETECT_RECORD_KINDS,
  DETECT_RECORD_KIND_LABELS,
  DETECT_TASK_STATUS_LABELS,
  normalizeDetectTaskStatus,
  type DetectRecordKind,
  type DetectTaskStatus,
} from '@lse/shared';
import { prisma } from '../../db.js';
import { ACTIVE_CORPUS_FINDING, ACTIVE_MODEL_FILE_FINDING } from '../../lib/detect-risk-scope.js';
import { loadRegisteredTargets, matchHitModels, originOf } from '../asset-discovery/service.js';
import {
  FINDING_CATEGORIES,
  FINDING_CATEGORY_LABELS,
  type FindingCategory,
} from '../corpus-scans/core/scan.js';
import type { CombinedRecordSnapshot } from './combined.js';
import { SEVERITY_ORDER, type SeverityKey } from './html/derive.js';
import { redactReportString } from './report-redaction.js';

// 综合检测报告（2.4.7）里「其他检测项」的小结：模型文件、语料、资产测绘，以及没完成的评估类记录。
// 风险数与首页四类风险同口径（lib/detect-risk-scope.ts）：判为误报的不计。

const TOP_FINDINGS = 10;
const NOT_COUNTED = '未完成，未计入风险统计';

function severityKey(raw: string | null | undefined): SeverityKey {
  return raw && (SEVERITY_ORDER as string[]).includes(raw) ? (raw as SeverityKey) : 'UNSPECIFIED';
}

function topBySeverity(rows: Array<{ title: string; severity: SeverityKey }>) {
  return [...rows]
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
    .slice(0, TOP_FINDINGS);
}

function base(
  kind: DetectRecordKind,
  id: string,
  name: string,
  rawStatus: string,
  finishedAt: Date | null,
): CombinedRecordSnapshot {
  return {
    kind,
    category: DETECT_RECORD_KINDS[kind],
    id,
    name: redactReportString(name),
    status: normalizeDetectTaskStatus(rawStatus),
    finishedAt: finishedAt?.toISOString() ?? null,
    riskCount: 0,
    bySeverity: {},
    lines: [],
    topFindings: [],
  };
}

/** 没完成的记录：只写状态，不计风险。 */
function notCompleted(rec: CombinedRecordSnapshot, error?: string | null): CombinedRecordSnapshot {
  const status = DETECT_TASK_STATUS_LABELS[rec.status as DetectTaskStatus] ?? rec.status;
  rec.lines = [`状态：${status}${error ? `（${redactReportString(error)}）` : ''}。${NOT_COUNTED}`];
  return rec;
}

/** 单条检测记录的小结（在调用者的租户范围内查）。记录不存在时返回空。 */
export async function summarizeDetectRecord(
  kind: DetectRecordKind,
  id: string,
): Promise<CombinedRecordSnapshot | null> {
  if (kind === 'model_file_scan') {
    const scan = await prisma.modelFileScan.findUnique({ where: { id } });
    if (!scan) return null;
    const rec = base(kind, id, scan.path, scan.status, scan.finishedAt);
    if (rec.status !== 'COMPLETED') return notCompleted(rec, scan.error);
    const findings = await prisma.modelFileFinding.findMany({
      where: { scanId: id, ...ACTIVE_MODEL_FILE_FINDING },
      select: { title: true, severity: true },
    });
    rec.riskCount = findings.length;
    for (const f of findings) rec.bySeverity[f.severity] = (rec.bySeverity[f.severity] ?? 0) + 1;
    rec.lines = [
      `扫描文件 ${scan.fileCount} 个，跳过 ${scan.skippedCount} 个，发现风险 ${findings.length} 项。`,
    ];
    rec.topFindings = topBySeverity(
      findings.map((f) => ({
        title: redactReportString(f.title),
        severity: severityKey(f.severity),
      })),
    );
    return rec;
  }

  if (kind === 'corpus_scan') {
    const scan = await prisma.corpusScan.findFirst({ where: { id } });
    if (!scan) return null;
    const rec = base(kind, id, scan.fileName, scan.status, scan.finishedAt);
    if (rec.status !== 'COMPLETED') return notCompleted(rec, scan.error);
    const findings = await prisma.corpusFinding.findMany({
      where: { scanId: id, ...ACTIVE_CORPUS_FINDING },
      select: { category: true, subtype: true, subtypeLabel: true, severity: true },
    });
    rec.riskCount = findings.length;
    const byCategory = new Map<string, number>();
    for (const f of findings) {
      rec.bySeverity[f.severity] = (rec.bySeverity[f.severity] ?? 0) + 1;
      byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + 1);
    }
    const parts = FINDING_CATEGORIES.map(
      (c) => `${FINDING_CATEGORY_LABELS[c]} ${byCategory.get(c) ?? 0} 条`,
    );
    rec.lines = [
      `检测记录 ${scan.totalRecords} 条，非法行 ${scan.invalidRecords} 条。`,
      `命中 ${findings.length} 条：${parts.join('、')}。`,
      ...(scan.truncated ? ['命中超过保存上限，只统计已保存的命中。'] : []),
    ];
    rec.topFindings = topBySeverity(
      findings.map((f) => ({
        title: `${FINDING_CATEGORY_LABELS[f.category as FindingCategory] ?? f.category}：${redactReportString(f.subtypeLabel ?? f.subtype)}`,
        severity: severityKey(f.severity),
      })),
    );
    return rec;
  }

  if (kind === 'asset_discovery') {
    const run = await prisma.assetDiscoveryRun.findUnique({
      where: { id },
      include: { hits: true },
    });
    if (!run) return null;
    const rec = base(kind, id, run.targets.join('、'), run.status, run.finishedAt);
    if (rec.status !== 'COMPLETED') return notCompleted(rec, run.error);
    const targets = await loadRegisteredTargets();
    // 未登记的 AI 服务按「源地址 + 模型」去重，记高危。
    const unregistered = new Map<string, string>();
    for (const hit of run.hits) {
      for (const m of matchHitModels(hit.baseUrl, hit.models, targets)) {
        if (m.registered) continue;
        const key = `${originOf(hit.baseUrl) ?? hit.baseUrl}\u0000${m.model ?? ''}`;
        unregistered.set(
          key,
          `未登记的 AI 服务：${redactReportString(hit.baseUrl)}${m.model ? `（${redactReportString(m.model)}）` : ''}`,
        );
      }
    }
    rec.riskCount = unregistered.size;
    if (unregistered.size > 0) rec.bySeverity.HIGH = unregistered.size;
    rec.lines = [
      `探测端点 ${run.endpointCount} 个，命中 AI 服务 ${run.hits.length} 个，其中未登记 ${unregistered.size} 个。`,
    ];
    rec.topFindings = [...unregistered.values()]
      .slice(0, TOP_FINDINGS)
      .map((title) => ({ title, severity: 'HIGH' as const }));
    return rec;
  }

  // 评估类记录（评估任务、终端体检）：已完成的走组合报告的任务口径，这里只处理没完成的。
  const task = await prisma.evalTask.findUnique({
    where: { id },
    select: { name: true, status: true, finishedAt: true },
  });
  if (!task) return null;
  const rec = base(kind, id, task.name, task.status, task.finishedAt);
  if (rec.status === 'COMPLETED') {
    rec.lines = [`${DETECT_RECORD_KIND_LABELS[kind]}已完成。`];
    return rec;
  }
  return notCompleted(rec);
}
