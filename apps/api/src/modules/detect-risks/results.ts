import { Prisma } from '@prisma/client';
import { detectRecordHref, type DetectRecordKind } from '@lse/shared';
import { prisma } from '../../db.js';
import { evalTaskRecordKindSql } from '../../lib/detect-sql.js';
import { localizeFindingTag, riskLabel } from '../reports/labels.js';
import { modelFileRule } from '../model-files/rules.js';
import {
  RATED_SEVERITIES,
  RISK_SEVERITY_KEYS,
  aiComponentWhere,
  corpusWhere,
  evalFindingSql,
  modelFileWhere,
  serviceAssuranceWhere,
  RiskCounter,
  type RatedSeverity,
  type RiskSeverityKey,
} from './stats.js';
import { RISK_SOURCES, type RiskSourceKey } from './sources.js';

// 检测结果明细（2.5.3）：每个来源的有效风险逐行列出，条件与 stats.ts 的计数同一份，所以列表合计等于计数。
// 排序：严重度从高到低（未定级最后），同一严重度按时间倒序。按严重度分桶取页：先按计数算出本页落在哪些桶、
// 每桶跳过多少，再逐桶查，这样字符串严重度（语料）和可空严重度（服务核验）也能按同一顺序分页。

export interface DetectResultRow {
  source: RiskSourceKey;
  id: string;
  /** 全部租户视角下点记录要先进入所属租户 */
  tenantId: string | null;
  title: string;
  severity: RiskSeverityKey;
  /** 风险落在什么上：评估对象、文件路径、语料记录、组件、服务地址 */
  subject: string | null;
  recordKind: DetectRecordKind;
  recordId: string;
  recordName: string | null;
  href: string;
  createdAt: Date;
}

/** 取哪一页；窗口、范围、租户取 RiskCounter 的。 */
export interface RiskResultQuery {
  /** 只看这些严重度；不传为全部 */
  severities?: readonly RiskSeverityKey[];
  page: number;
  pageSize: number;
}

/** 评估风险项标题：把「[引擎] 代码」译成中文风险类别，再去掉开头的「[引擎]」；空的用风险类别名。 */
export function findingDisplayTitle(
  title: string | null,
  riskCategory: string,
  engine: string,
): string {
  const text = localizeFindingTag(title ?? '')
    .replace(/^\[[^\]]*\]\s*/, '')
    .trim();
  return text || riskLabel(riskCategory, engine);
}

interface Slice {
  severity: RiskSeverityKey;
  skip: number;
  take: number;
}

/** 本页落在哪些严重度桶里、每桶跳过多少取多少。 */
function pageSlices(
  counts: Record<RiskSeverityKey, number>,
  keys: readonly RiskSeverityKey[],
  page: number,
  pageSize: number,
): Slice[] {
  let offset = (page - 1) * pageSize;
  let remaining = pageSize;
  const out: Slice[] = [];
  for (const severity of keys) {
    if (remaining <= 0) break;
    const n = counts[severity];
    if (offset >= n) {
      offset -= n;
      continue;
    }
    const take = Math.min(remaining, n - offset);
    out.push({ severity, skip: offset, take });
    remaining -= take;
    offset = 0;
  }
  return out;
}

const rated = (s: RiskSeverityKey): RatedSeverity | null => (s === 'UNRATED' ? null : s);

function row(
  source: RiskSourceKey,
  kind: DetectRecordKind,
  fields: Omit<DetectResultRow, 'source' | 'recordKind' | 'href'>,
): DetectResultRow {
  return { source, recordKind: kind, href: detectRecordHref(kind, fields.recordId), ...fields };
}

const latest = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

async function fetchSlice(
  source: RiskSourceKey,
  slice: Slice,
  counter: RiskCounter,
): Promise<DetectResultRow[]> {
  const { window: w, scope, tenantId } = counter;
  const { skip, take } = slice;
  const kind = RISK_SOURCES[source].recordKind;
  switch (source) {
    case 'eval_content':
    case 'eval_app': {
      const category = source === 'eval_content' ? 'content' : 'app_env';
      const rows = await prisma.$queryRaw<
        Array<{
          id: string;
          tenantId: string | null;
          title: string | null;
          engine: string;
          riskCategory: string;
          severity: string;
          createdAt: Date;
          taskId: string;
          taskName: string;
          targetName: string | null;
          kind: DetectRecordKind;
        }>
      >(Prisma.sql`SELECT f."id", t."tenantId", f."title", f."engine", f."riskCategory", f."severity"::text AS severity,
          f."createdAt", t."id" AS "taskId", t."name" AS "taskName",
          (SELECT mt."name" FROM "model_targets" mt WHERE mt."id" = t."modelTargetId") AS "targetName",
          ${evalTaskRecordKindSql('t')} AS kind
        ${evalFindingSql(category, w, scope, tenantId)}
          AND f."severity"::text = ${slice.severity}
        ORDER BY f."createdAt" DESC, f."id" DESC
        LIMIT ${take} OFFSET ${skip}`);
      return rows.map((r) =>
        row(source, r.kind, {
          id: r.id,
          tenantId: r.tenantId,
          title: findingDisplayTitle(r.title, r.riskCategory, r.engine),
          severity: slice.severity,
          subject: r.targetName,
          recordId: r.taskId,
          recordName: r.taskName,
          createdAt: r.createdAt,
        }),
      );
    }
    case 'model_file': {
      const rows = await prisma.modelFileFinding.findMany({
        where: {
          AND: [
            modelFileWhere(w, scope, tenantId),
            { severity: rated(slice.severity) ?? undefined },
          ],
        },
        orderBy: latest,
        skip,
        take,
        select: {
          id: true,
          tenantId: true,
          ruleId: true,
          title: true,
          filePath: true,
          createdAt: true,
          scanId: true,
          scan: { select: { path: true } },
        },
      });
      return rows.map((r) =>
        row(source, kind, {
          id: r.id,
          tenantId: r.tenantId,
          title: modelFileRule(r.ruleId)?.title ?? r.title,
          severity: slice.severity,
          subject: r.filePath,
          recordId: r.scanId,
          recordName: r.scan.path,
          createdAt: r.createdAt,
        }),
      );
    }
    case 'corpus': {
      const severity: Prisma.CorpusFindingWhereInput =
        slice.severity === 'UNRATED'
          ? { severity: { notIn: [...RATED_SEVERITIES] } }
          : { severity: slice.severity };
      const rows = await prisma.corpusFinding.findMany({
        where: { AND: [corpusWhere(w, scope, tenantId), severity] },
        orderBy: latest,
        skip,
        take,
        select: {
          id: true,
          tenantId: true,
          subtype: true,
          subtypeLabel: true,
          recordIndex: true,
          fieldPath: true,
          createdAt: true,
          scanId: true,
          scan: { select: { fileName: true } },
        },
      });
      return rows.map((r) =>
        row(source, kind, {
          id: r.id,
          tenantId: r.tenantId,
          title: r.subtypeLabel ?? r.subtype,
          severity: slice.severity,
          subject: `第 ${r.recordIndex} 条 ${r.fieldPath}`,
          recordId: r.scanId,
          recordName: r.scan.fileName,
          createdAt: r.createdAt,
        }),
      );
    }
    case 'service_assurance': {
      const rows = await prisma.vulnerabilityAssessment.findMany({
        where: {
          AND: [serviceAssuranceWhere(w, scope, tenantId), { severity: rated(slice.severity) }],
        },
        orderBy: latest,
        skip,
        take,
        select: {
          id: true,
          tenantId: true,
          title: true,
          createdAt: true,
          runId: true,
          component: { select: { name: true } },
          run: { select: { targetName: true } },
        },
      });
      return rows.map((r) =>
        row(source, kind, {
          id: r.id,
          tenantId: r.tenantId,
          title: r.title,
          severity: slice.severity,
          subject: r.component?.name ?? r.run.targetName,
          recordId: r.runId,
          recordName: r.run.targetName,
          createdAt: r.createdAt,
        }),
      );
    }
    case 'ai_component': {
      const rows = await prisma.aiComponentFinding.findMany({
        where: {
          AND: [
            aiComponentWhere(w, scope, tenantId),
            { severity: rated(slice.severity) ?? undefined },
          ],
        },
        orderBy: latest,
        skip,
        take,
        select: {
          id: true,
          tenantId: true,
          title: true,
          createdAt: true,
          scanId: true,
          scan: { select: { assetName: true } },
        },
      });
      return rows.map((r) =>
        row(source, kind, {
          id: r.id,
          tenantId: r.tenantId,
          title: r.title,
          severity: slice.severity,
          subject: r.scan.assetName,
          recordId: r.scanId,
          recordName: r.scan.assetName,
          createdAt: r.createdAt,
        }),
      );
    }
    case 'asset_discovery': {
      // 只有高危一档，按最近命中时间倒序；用计数那一次查出的结果切页。
      const { services } = await counter.unregistered();
      return services.slice(skip, skip + take).map((s) =>
        row(source, kind, {
          id: `${s.runId}:${s.origin}:${s.model ?? ''}`,
          tenantId: s.tenantId,
          title: `未登记 AI 服务：${s.model ?? s.baseUrl}`,
          severity: slice.severity,
          subject: s.baseUrl,
          recordId: s.runId,
          recordName: s.runTargets.slice(0, 3).join('、') + (s.runTargets.length > 3 ? ' 等' : ''),
          createdAt: s.runCreatedAt,
        }),
      );
    }
  }
}

/**
 * 某来源的明细一页，total 为筛选严重度后的合计。
 * counter 与来源合计共用：复用它的分档计数和未登记服务，不再重算。
 */
export async function listRiskResults(
  source: RiskSourceKey,
  q: RiskResultQuery,
  counter: RiskCounter,
): Promise<{ items: DetectResultRow[]; total: number }> {
  const counts = await counter.severityCounts(source);
  const keys = RISK_SEVERITY_KEYS.filter((k) => !q.severities || q.severities.includes(k));
  const total = keys.reduce((sum, k) => sum + counts[k], 0);
  const slices = pageSlices(counts, keys, q.page, q.pageSize);
  const pages = await Promise.all(slices.map((slice) => fetchSlice(source, slice, counter)));
  return { items: pages.flat(), total };
}
