import type { Prisma, PrismaClient } from '@prisma/client';
import {
  ANNEX_A_ITEMS,
  evaluateKeywordCoverage,
  isAnnexItemCode,
  type KeywordCoverage,
} from '@lse/shared';
import { forbidden } from '../../lib/errors.js';
import { parseCsv } from '../../lib/question-import.js';
import { csvCell, restoreFormula } from '../../lib/tabular-export.js';
import { currentTenantScope, isAllTenantsScope } from '../../lib/tenant-context.js';
import { PLATFORM_TENANT_ID } from '../../lib/tenant-models.js';
import { AUTO_KEYWORD_SOURCE } from '../question-sets/bank-updates/constants.js';

/**
 * 关键词状态：approved 在用（参与判定）、pending 待确认（不参与判定，命中只统计）、
 * disabled 停用（人工停用，不参与判定，命中也不统计）、rejected 已剔除（版本淘汰，页面默认不显示）。
 */
export const KEYWORD_REVIEW_STATUSES = ['pending', 'approved', 'disabled', 'rejected'] as const;
export type KeywordReviewStatus = (typeof KEYWORD_REVIEW_STATUSES)[number];
/** 人工可以改的状态：已剔除的词由版本同步管理，不能手工改。 */
export const KEYWORD_EDITABLE_STATUSES = ['approved', 'pending', 'disabled'] as const;
export type KeywordEditableStatus = (typeof KEYWORD_EDITABLE_STATUSES)[number];

export const REVIEW_STATUS_LABELS: Record<KeywordReviewStatus, string> = {
  approved: '在用',
  pending: '待确认',
  disabled: '停用',
  rejected: '已剔除',
};

const isEditableStatus = (s: string): s is KeywordEditableStatus =>
  (KEYWORD_EDITABLE_STATUSES as readonly string[]).includes(s);

/** 来源：内置 / 导入 / 每周更新；其他（如 manual）记为手工。 */
export function keywordSourceLabel(source: string): string {
  if (source.startsWith('builtin:')) return '内置';
  if (source.startsWith('import:')) return '导入';
  if (source === AUTO_KEYWORD_SOURCE) return '每周更新';
  return '手工';
}

export interface KeywordIssue {
  row: number;
  message: string;
}

export interface ParsedKeywords {
  /** status 只在文件带状态列时有：候选的按候选导入，其余按生效。 */
  rows: { itemCode: string; term: string; status?: 'approved' | 'pending' }[];
  issues: KeywordIssue[];
  totalRows: number;
  /** 文件带状态列时，状态为停用、已剔除而没有导入的行数。 */
  skippedInactive: number;
}

const normItem = (s: string) => s.trim().replace(/^a\./i, 'A.');
const cleanTerm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** 导入文件状态列的取值（导出的是中文标签，也认英文）：停用、已剔除的行不导入。 */
const IMPORT_STATUS: Record<string, 'approved' | 'pending' | 'skip'> = {
  '': 'approved',
  在用: 'approved',
  生效: 'approved',
  approved: 'approved',
  待确认: 'pending',
  候选: 'pending',
  pending: 'pending',
  停用: 'skip',
  disabled: 'skip',
  已剔除: 'skip',
  rejected: 'skip',
};

function pushRow(out: ParsedKeywords, rowNo: number, itemRaw: string, termRaw: string, statusRaw?: string) {
  let status: 'approved' | 'pending' | undefined;
  if (statusRaw !== undefined) {
    const s = IMPORT_STATUS[statusRaw.trim().toLowerCase()];
    if (!s) {
      return void out.issues.push({
        row: rowNo,
        message: `状态「${statusRaw.trim()}」不认识，应为在用、待确认或停用`,
      });
    }
    if (s === 'skip') return void (out.skippedInactive += 1);
    status = s;
  }
  const itemCode = normItem(itemRaw);
  const term = cleanTerm(termRaw);
  if (!term) return void out.issues.push({ row: rowNo, message: '关键词为空' });
  if (term.length > 50) return void out.issues.push({ row: rowNo, message: '关键词超过 50 字' });
  if (!isAnnexItemCode(itemCode)) {
    return void out.issues.push({ row: rowNo, message: `附录 A 小项编号「${itemCode}」不存在，应形如 A.2.e` });
  }
  out.rows.push(status ? { itemCode, term, status } : { itemCode, term });
}

/**
 * 解析关键词导入文件。
 * - CSV：表头含 itemCode（或「小项」）与 term（或「关键词」）；没有表头时按「小项,关键词」两列处理；
 *   带 reviewStatus（或「状态」）列时（如本页导出的文件），停用、已剔除的行不导入，候选的按候选导入；
 * - TXT：每行一个关键词，需要在 defaultItem 里指定小项；也可以每行写「A.2.e,关键词」或「A.2.e<TAB>关键词」。
 */
export function parseKeywordImport(
  format: 'csv' | 'txt',
  text: string,
  defaultItem: string | null,
): ParsedKeywords {
  const out: ParsedKeywords = { rows: [], issues: [], totalRows: 0, skippedInactive: 0 };
  const def = defaultItem ? normItem(defaultItem) : null;
  if (format === 'csv') {
    // 导出给公式触发字符开头的单元格加了 `'`，导回时去掉，保证往返一致。
    const table = parseCsv(text)
      .map((r) => r.map(restoreFormula))
      .filter((r) => r.some((c) => c.trim() !== ''));
    if (table.length === 0) {
      out.issues.push({ row: 1, message: '文件是空的' });
      return out;
    }
    const header = table[0]!.map((h) => h.trim().replace(/^﻿/, '').toLowerCase());
    const iItem = header.findIndex((h) => ['itemcode', '小项', '小项编号'].includes(h));
    const iTerm = header.findIndex((h) => ['term', '关键词', '词'].includes(h));
    const iStatus = header.findIndex((h) => ['reviewstatus', '状态'].includes(h));
    const hasHeader = iItem >= 0 && iTerm >= 0;
    const hasHeaderTermOnly = !hasHeader && iTerm >= 0 && def !== null;
    const start = hasHeader || hasHeaderTermOnly ? 1 : 0;
    for (let i = start; i < table.length; i++) {
      out.totalRows++;
      const cells = table[i]!;
      const statusRaw = iStatus >= 0 && (hasHeader || hasHeaderTermOnly) ? (cells[iStatus] ?? '') : undefined;
      if (hasHeader) pushRow(out, i + 1, cells[iItem] ?? '', cells[iTerm] ?? '', statusRaw);
      else if (hasHeaderTermOnly) pushRow(out, i + 1, def!, cells[iTerm] ?? '', statusRaw);
      else if (cells.length >= 2) pushRow(out, i + 1, cells[0] ?? '', cells[1] ?? '');
      else if (def) pushRow(out, i + 1, def, cells[0] ?? '');
      else out.issues.push({ row: i + 1, message: '缺少小项编号' });
    }
    return out;
  }
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) return;
    out.totalRows++;
    const m = line.match(/^(A\.\d\.[a-z])[\t,，]\s*(.+)$/i);
    if (m) return pushRow(out, idx + 1, m[1]!, m[2]!);
    if (def) return pushRow(out, idx + 1, def, line);
    out.issues.push({ row: idx + 1, message: '未指定小项：请选择小项，或每行写成「A.2.e,关键词」' });
  });
  return out;
}

/** 导入归属：平台管理员在平台租户里导入的是平台共享词表（tenantId 为空），其他租户只写自己的。 */
export function keywordTenantId(): string | null {
  const scope = currentTenantScope();
  if (!scope) return null;
  return scope.sharedWrite ? null : scope.tenantId;
}

/**
 * 读取可见范围：平台共享词表 + 当前租户自己的。关键词库不在租户查询扩展的清单里，读取处都要带上它
 * （首页规则库统计也用它）。
 */
export function visibleWhere(): Prisma.StandardKeywordWhereInput {
  const scope = currentTenantScope();
  return scope ? { OR: [{ tenantId: null }, { tenantId: scope.tenantId }] } : {};
}

export interface KeywordImportResult {
  totalRows: number;
  added: number;
  duplicates: number;
  failed: number;
  issues: KeywordIssue[];
  byItem: Record<string, number>;
  /** 状态为停用、已剔除而没有导入的行数。 */
  skippedInactive: number;
}

export async function importKeywords(
  db: PrismaClient,
  parsed: ParsedKeywords,
  opts: { source: string; reviewStatus?: KeywordReviewStatus; tenantId?: string | null },
): Promise<KeywordImportResult> {
  const tenantId = opts.tenantId === undefined ? keywordTenantId() : opts.tenantId;
  const result: KeywordImportResult = {
    totalRows: parsed.totalRows,
    added: 0,
    duplicates: 0,
    failed: parsed.issues.length,
    issues: parsed.issues,
    byItem: {},
    skippedInactive: parsed.skippedInactive ?? 0,
  };
  // 客户导入的词默认生效；文件带状态列时候选的按候选导入。同一个词出现多次取第一次的状态。
  const statusOf = new Map<string, KeywordReviewStatus>();
  for (const r of parsed.rows) {
    const k = `${r.itemCode}\u0000${r.term}`;
    if (!statusOf.has(k)) statusOf.set(k, r.status ?? opts.reviewStatus ?? 'approved');
  }
  const items = [...new Set(parsed.rows.map((r) => r.itemCode))];
  for (const itemCode of items) {
    const terms = [...new Set(parsed.rows.filter((r) => r.itemCode === itemCode).map((r) => r.term))];
    result.duplicates += parsed.rows.filter((r) => r.itemCode === itemCode).length - terms.length;
    const have = new Set(
      (await db.standardKeyword.findMany({ where: { tenantId, itemCode }, select: { term: true } })).map((k) => k.term),
    );
    const fresh = terms.filter((t) => !have.has(t));
    result.duplicates += terms.length - fresh.length;
    for (let i = 0; i < fresh.length; i += 2000) {
      await db.standardKeyword.createMany({
        data: fresh.slice(i, i + 2000).map((term) => ({
          tenantId,
          itemCode,
          term,
          source: opts.source,
          reviewStatus: statusOf.get(`${itemCode}\u0000${term}`) ?? 'approved',
        })),
        skipDuplicates: true,
      });
    }
    result.added += fresh.length;
    if (fresh.length) result.byItem[itemCode] = fresh.length;
  }
  return result;
}

export interface KeywordStatusResult {
  to: 'approved' | 'disabled';
  /** 改动涉及的小项：按小项改时为该小项；按 id 改且都在同一小项时为该小项，否则为空。 */
  itemCode: string | null;
  changed: number;
  /** 改动的词（最多 20 个，写审计用）。 */
  terms: string[];
}

/**
 * 批量改状态：按 id，或按「小项 + 原状态」（例如把某小项的候选全部改为生效）。
 * 只能改自己有权写的那一份：能写平台共享词表的账号改平台词，租户只改本租户导入的词；
 * 按 id 改时只要有一个不归自己（或不存在）就整体拒绝。已剔除的词由版本同步管理，不改。
 */
export async function setKeywordStatus(
  db: PrismaClient,
  opts: {
    ids?: string[];
    itemCode?: string;
    fromStatus?: KeywordEditableStatus;
    to: 'approved' | 'disabled';
    actorName: string;
    tenantId?: string | null;
  },
): Promise<KeywordStatusResult> {
  const tenantId = opts.tenantId === undefined ? keywordTenantId() : opts.tenantId;
  let scope: Prisma.StandardKeywordWhereInput;
  if (opts.ids) {
    const ids = [...new Set(opts.ids)];
    const owners = await db.standardKeyword.findMany({ where: { id: { in: ids } }, select: { tenantId: true } });
    if (owners.length !== ids.length) {
      throw forbidden(`有 ${ids.length - owners.length} 个关键词不存在或已删除`);
    }
    if (owners.some((r) => r.tenantId !== tenantId)) {
      if (tenantId === null) throw forbidden('租户导入的关键词只能由该租户修改');
      if (owners.some((r) => r.tenantId === null)) throw forbidden('平台词表只有平台管理员可以修改');
      throw forbidden('只能修改本租户导入的关键词');
    }
    scope = { id: { in: ids } };
  } else {
    scope = { tenantId, itemCode: opts.itemCode, reviewStatus: opts.fromStatus };
  }
  const from = KEYWORD_EDITABLE_STATUSES.filter((s) => s !== opts.to);
  const targets = await db.standardKeyword.findMany({
    where: { AND: [scope, { reviewStatus: { in: from } }] },
    select: { id: true, itemCode: true, term: true },
    orderBy: [{ itemCode: 'asc' }, { term: 'asc' }],
  });
  const now = new Date();
  let changed = 0;
  for (let i = 0; i < targets.length; i += 2000) {
    const r = await db.standardKeyword.updateMany({
      where: { id: { in: targets.slice(i, i + 2000).map((t) => t.id) }, reviewStatus: { in: from } },
      data: { reviewStatus: opts.to, statusChangedAt: now, statusChangedBy: opts.actorName },
    });
    changed += r.count;
  }
  const items = [...new Set(targets.map((t) => t.itemCode))];
  return {
    to: opts.to,
    itemCode: opts.itemCode ?? (items.length === 1 ? items[0]! : null),
    changed,
    terms: targets.slice(0, 20).map((t) => t.term),
  };
}

export interface KeywordItemStatusCounts {
  approved: number;
  pending: number;
  disabled: number;
}

export interface KeywordCoverageReport extends KeywordCoverage {
  /** 各状态词数。 */
  byStatus: Record<string, number>;
  /** 每个小项的生效、候选、停用词数。 */
  byItemStatus: Record<string, KeywordItemStatusCounts>;
}

/** 覆盖统计：数量和达标只算生效的词；已剔除的词不计入。 */
export async function computeKeywordCoverage(db: PrismaClient): Promise<KeywordCoverageReport> {
  const groups = await db.standardKeyword.groupBy({
    by: ['itemCode', 'reviewStatus'],
    where: { ...visibleWhere() },
    _count: true,
  });
  const counts: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byItemStatus: Record<string, KeywordItemStatusCounts> = {};
  for (const g of groups) {
    byStatus[g.reviewStatus] = (byStatus[g.reviewStatus] ?? 0) + g._count;
    if (!isEditableStatus(g.reviewStatus)) continue;
    const cell = (byItemStatus[g.itemCode] ??= { approved: 0, pending: 0, disabled: 0 });
    cell[g.reviewStatus] += g._count;
    if (g.reviewStatus === 'approved') counts[g.itemCode] = (counts[g.itemCode] ?? 0) + g._count;
  }
  const coverage = evaluateKeywordCoverage(counts);
  // 没有生效词、只有候选或停用词的非必需小项也列出来，才能打开它把词启用。
  const listed = new Map(coverage.rows.map((r) => [r.key, r]));
  const rows = ANNEX_A_ITEMS.flatMap((i) => {
    const row = listed.get(i.code);
    if (row) return [row];
    if (!byItemStatus[i.code]) return [];
    return [{ key: i.code, label: `${i.code} ${i.name}`, count: 0, min: 0, gap: 0, ok: true, importOnly: false }];
  });
  return { ...coverage, rows, byStatus, byItemStatus };
}

export async function listKeywords(
  db: PrismaClient,
  q: { itemCode?: string; keyword?: string; reviewStatus?: string; page: number; pageSize: number },
) {
  const where: Prisma.StandardKeywordWhereInput = {
    ...visibleWhere(),
    ...(q.itemCode ? { itemCode: q.itemCode } : {}),
    // 已剔除的词默认不列，筛选「已剔除」时才列。
    reviewStatus: q.reviewStatus ? q.reviewStatus : { not: 'rejected' },
    ...(q.keyword ? { term: { contains: q.keyword } } : {}),
  };
  // 「全部租户」视角只读；归属按当前租户判断。
  const allTenants = isAllTenantsScope();
  const viewer = currentTenantScope()?.tenantId ?? null;
  const own = keywordTenantId();
  // 平台词是谁改的只给平台账号看（平台租户或全部租户视角），租户只看到时间。
  const platformViewer = allTenants || viewer === null || viewer === PLATFORM_TENANT_ID;
  const [total, rows, editableTotal] = await Promise.all([
    db.standardKeyword.count({ where }),
    db.standardKeyword.findMany({
      where,
      orderBy: [{ itemCode: 'asc' }, { term: 'asc' }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    allTenants
      ? Promise.resolve(0)
      : db.standardKeyword.count({
          where: { AND: [where, { tenantId: own, reviewStatus: { in: [...KEYWORD_EDITABLE_STATUSES] } }] },
        }),
  ]);
  return {
    total,
    /** 当前筛选下自己能改状态的词数。 */
    editableTotal,
    /** 当前账号改的是平台共享词表（会影响所有租户的判定）。 */
    writesPlatform: !allTenants && own === null,
    page: q.page,
    pageSize: q.pageSize,
    items: rows.map((r) => ({
      id: r.id,
      itemCode: r.itemCode,
      itemName: ANNEX_A_ITEMS.find((i) => i.code === r.itemCode)?.name ?? r.itemCode,
      term: r.term,
      source: r.source,
      sourceLabel: keywordSourceLabel(r.source),
      reviewStatus: r.reviewStatus,
      reviewStatusLabel: REVIEW_STATUS_LABELS[r.reviewStatus as KeywordReviewStatus] ?? r.reviewStatus,
      statusChangedAt: r.statusChangedAt,
      statusChangedBy: r.tenantId === null && !platformViewer ? null : r.statusChangedBy,
      editable: !allTenants && r.tenantId === own && isEditableStatus(r.reviewStatus),
      scope: r.tenantId === null ? '平台' : r.tenantId === viewer ? '本租户' : '其他租户',
      createdAt: r.createdAt,
    })),
  };
}

/** 导出可见的词（不含已剔除的），状态列用中文；导回时停用的行不导入。 */
export async function exportKeywordsCsv(db: PrismaClient, itemCode?: string): Promise<string> {
  const rows = await db.standardKeyword.findMany({
    where: { ...visibleWhere(), ...(itemCode ? { itemCode } : {}), reviewStatus: { not: 'rejected' } },
    orderBy: [{ itemCode: 'asc' }, { term: 'asc' }],
  });
  const lines = ['itemCode,term,source,reviewStatus'];
  for (const r of rows) {
    const status = REVIEW_STATUS_LABELS[r.reviewStatus as KeywordReviewStatus] ?? r.reviewStatus;
    lines.push([r.itemCode, r.term, r.source, status].map(csvCell).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}
