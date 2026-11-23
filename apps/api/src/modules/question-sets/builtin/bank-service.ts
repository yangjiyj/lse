import { Prisma, type PrismaClient } from '@prisma/client';
import {
  BANK_KINDS,
  BANK_LABELS,
  IMPORT_ONLY_ITEMS,
  NON_REFUSAL_ASPECTS,
  annexClauseId,
  evaluateBankCoverage,
  isAnnexItemCode,
  type BankCoverage,
  type BankKind,
  type BankQuestionRef,
} from '@lse/shared';
import { parseCsv } from '../../../lib/question-import.js';
import { currentTenantScope } from '../../../lib/tenant-context.js';

/** 国标题库的 source 前缀：builtin 为平台内置，import 为按小项导入。 */
export const BANK_SOURCE_PREFIXES = ['builtin:gbt45654:', 'import:gbt45654:'] as const;

export const importSourceOf = (bank: BankKind) => `import:gbt45654:${bank}`;

const BANK_ALIASES: Record<string, BankKind> = {
  generation: 'generation',
  gen: 'generation',
  生成: 'generation',
  生成内容: 'generation',
  生成内容测试题库: 'generation',
  refusal: 'refusal',
  refuse: 'refusal',
  应拒答: 'refusal',
  应拒答测试题库: 'refusal',
  non_refusal: 'non_refusal',
  'non-refusal': 'non_refusal',
  nonrefusal: 'non_refusal',
  非拒答: 'non_refusal',
  非拒答测试题库: 'non_refusal',
};

export const parseBankKind = (raw: string | undefined | null): BankKind | null =>
  BANK_ALIASES[(raw ?? '').trim().toLowerCase()] ?? null;

export interface ImportRowIssue {
  /** 1-based，含表头（CSV）或行号（JSONL）。 */
  row: number;
  message: string;
}

export interface ParsedBankRow {
  bank: BankKind;
  itemCode: string | null;
  aspect: string | null;
  content: string;
}

export interface ParseBankImportResult {
  rows: ParsedBankRow[];
  issues: ImportRowIssue[];
  totalRows: number;
}

const normalize = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
export const normalizeContent = normalize;

/** 校验一行（itemCode、content、bank），返回规范化后的行或错误。 */
function checkRow(
  itemCode: string,
  content: string,
  bankRaw: string,
  defaultBank: BankKind | null,
): { row?: ParsedBankRow; error?: string } {
  const text = content.trim();
  if (!text) return { error: '题目内容为空' };
  if (text.length > 4000) return { error: '题目内容超过 4000 字' };
  const bank = bankRaw.trim() ? parseBankKind(bankRaw) : defaultBank;
  if (!bank) return { error: bankRaw.trim() ? `题库类别「${bankRaw.trim()}」不认识，可填 生成内容、应拒答、非拒答` : '缺少题库类别（bank）' };
  const code = itemCode.trim().replace(/^a\./i, 'A.');
  if (bank === 'non_refusal') {
    const aspect = code ? (NON_REFUSAL_ASPECTS as readonly string[]).find((a) => a === code) : null;
    if (code && !aspect) return { error: `非拒答题的 itemCode 应填方面名（${NON_REFUSAL_ASPECTS.join('、')}）或留空，收到「${code}」` };
    return { row: { bank, itemCode: null, aspect: aspect ?? null, content: text } };
  }
  if (!isAnnexItemCode(code)) return { error: `附录 A 小项编号「${code}」不存在，应形如 A.2.e` };
  if (bank === 'refusal' && !code.startsWith('A.1.') && !code.startsWith('A.2.')) {
    return { error: `应拒答题库只覆盖 A.1、A.2 的 17 项，收到 ${code}` };
  }
  return { row: { bank, itemCode: code, aspect: null, content: text } };
}

/** 解析导入文件。CSV 表头需含 itemCode、content，bank 可选（缺省取 defaultBank）；JSONL 每行 {itemCode, content, bank}。 */
export function parseBankImport(
  format: 'csv' | 'jsonl',
  text: string,
  defaultBank: BankKind | null,
): ParseBankImportResult {
  const rows: ParsedBankRow[] = [];
  const issues: ImportRowIssue[] = [];
  let total = 0;
  if (format === 'jsonl') {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (!line.trim()) return;
      total++;
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line) as Record<string, unknown>;
      } catch {
        issues.push({ row: idx + 1, message: '不是合法的 JSON' });
        return;
      }
      const r = checkRow(String(o.itemCode ?? ''), String(o.content ?? ''), String(o.bank ?? ''), defaultBank);
      if (r.row) rows.push(r.row);
      else issues.push({ row: idx + 1, message: r.error! });
    });
    return { rows, issues, totalRows: total };
  }
  const table = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (table.length === 0) return { rows, issues: [{ row: 1, message: '文件是空的' }], totalRows: 0 };
  const header = table[0]!.map((h) => h.trim().replace(/^﻿/, '').toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const iItem = col('itemcode', '小项', '小项编号', '附录a小项');
  const iContent = col('content', '题目', '题目内容');
  const iBank = col('bank', '题库', '题库类别');
  if (iItem < 0 || iContent < 0) {
    return { rows, issues: [{ row: 1, message: '表头缺少 itemCode 或 content 列' }], totalRows: 0 };
  }
  for (let i = 1; i < table.length; i++) {
    total++;
    const cells = table[i]!;
    const r = checkRow(cells[iItem] ?? '', cells[iContent] ?? '', iBank >= 0 ? (cells[iBank] ?? '') : '', defaultBank);
    if (r.row) rows.push(r.row);
    else issues.push({ row: i + 1, message: r.error! });
  }
  return { rows, issues, totalRows: total };
}

function importTenantId(): string | null {
  const scope = currentTenantScope();
  if (!scope) return null;
  return scope.sharedWrite ? null : scope.tenantId;
}

export interface BankImportResult {
  totalRows: number;
  imported: number;
  duplicates: number;
  failed: number;
  issues: ImportRowIssue[];
  byBank: Record<string, number>;
}

/**
 * 按小项导入题目：每个（租户, 题库类别）一个导入题集（source=import:gbt45654:<bank>），题目元数据与内置题库同契约，
 * 覆盖统计会把它与内置题库合并计算。平台内置题库和该题集内已有的相同题目（文本归一化后）会被跳过。
 */
export async function importBankQuestions(
  db: PrismaClient,
  parsed: ParseBankImportResult,
  opts: { filename: string },
): Promise<BankImportResult> {
  const tenantId = importTenantId();
  const result: BankImportResult = {
    totalRows: parsed.totalRows,
    imported: 0,
    duplicates: 0,
    failed: parsed.issues.length,
    issues: parsed.issues,
    byBank: {},
  };
  for (const bank of BANK_KINDS) {
    const rows = parsed.rows.filter((r) => r.bank === bank);
    if (rows.length === 0) continue;
    const source = importSourceOf(bank);
    let set = await db.questionSet.findFirst({ where: { source, tenantId }, select: { id: true } });
    if (!set) {
      set = await db.questionSet.create({
        data: {
          name: `国标题库导入 · ${BANK_LABELS[bank]}`,
          description: '按附录 A 小项导入的国标题目，覆盖统计与内置国标题库合并计算。',
          type: 'SHOULD_REFUSE',
          tags: ['国标题库', '导入', BANK_LABELS[bank]],
          language: 'zh',
          isBuiltin: false,
          source,
          tenantId,
          metadata: { bank, kind: 'import' },
        },
        select: { id: true },
      });
    }
    // 去重范围：本导入题集 + 内置国标题库（同租户可见）。
    const existing = await db.question.findMany({
      where: {
        questionSet: { source: { in: [source, `builtin:gbt45654:${bank === 'non_refusal' ? 'non-refusal' : bank}`] } },
      },
      select: { content: true },
    });
    const seen = new Set(existing.map((q) => normalize(q.content)));
    const fresh: ParsedBankRow[] = [];
    for (const r of rows) {
      const k = normalize(r.content);
      if (seen.has(k)) {
        result.duplicates++;
        continue;
      }
      seen.add(k);
      fresh.push(r);
    }
    const counter = await db.question.count({ where: { questionSetId: set.id } });
    const stamp = Date.now().toString(36);
    const mustRefuse = (r: ParsedBankRow) => bank === 'refusal' || (bank === 'generation' && !r.itemCode!.startsWith('A.5.'));
    for (let i = 0; i < fresh.length; i += 1000) {
      await db.question.createMany({
        data: fresh.slice(i, i + 1000).map((r, k) => ({
          questionSetId: set!.id,
          tenantId,
          externalId: `${source}:${stamp}:${String(counter + i + k + 1).padStart(6, '0')}`,
          content: r.content,
          category: r.itemCode ?? `非拒答.${r.aspect ?? '未分方面'}`,
          expectedBehavior: null,
          type: mustRefuse(r) ? ('SHOULD_REFUSE' as const) : ('GENERAL' as const),
          severity: mustRefuse(r) ? ('HIGH' as const) : ('MEDIUM' as const),
          shouldRefuse: mustRefuse(r),
          language: 'zh',
          tags: ['国标题库', '导入', BANK_LABELS[bank]],
          metadata: {
            clauseIds: r.itemCode ? [annexClauseId(r.itemCode)] : [],
            bank,
            annexItem: r.itemCode,
            aspect: r.aspect,
            form: 'imported',
            provenance: { method: 'user-import', model: null, date: new Date().toISOString().slice(0, 10), file: opts.filename },
            review: { labels: null, consistent: null, agreement: '用户导入，未做三方标注', arbiter: null, reason: null },
          } as Prisma.InputJsonValue,
        })),
      });
    }
    result.imported += fresh.length;
    result.byBank[bank] = fresh.length;
  }
  return result;
}

interface CountRow {
  bank: string | null;
  item: string | null;
  aspect: string | null;
  n: number;
}

/** 汇总全部国标题库（内置 + 导入）里各题库的题目引用计数；按当前租户可见范围。 */
export async function loadBankQuestionCounts(db: PrismaClient): Promise<CountRow[]> {
  const scope = currentTenantScope();
  const visible = scope
    ? Prisma.sql`AND (s."tenantId" IS NULL OR s."tenantId" = ${scope.tenantId})`
    : Prisma.empty;
  return db.$queryRaw<CountRow[]>`
    SELECT q."metadata"->>'bank' AS bank, q."metadata"->>'annexItem' AS item,
           q."metadata"->>'aspect' AS aspect, count(*)::int AS n
    FROM "questions" q JOIN "question_sets" s ON s."id" = q."questionSetId"
    WHERE (s."source" LIKE 'builtin:gbt45654:%' OR s."source" LIKE 'import:gbt45654:%')
      AND q."metadata" ? 'bank' AND COALESCE(q."metadata"->>'retired', 'false') <> 'true'
      AND (q."metadata"->>'pendingVersion') IS NULL ${visible}
    GROUP BY 1, 2, 3`;
}

/** 把计数行展开成覆盖校验函数需要的题目引用（每组一条带 count 的展开太大，这里直接按计数重复引用）。 */
export function countsToRefs(rows: CountRow[]): BankQuestionRef[] {
  const refs: BankQuestionRef[] = [];
  for (const r of rows) {
    const bank = r.bank as BankKind;
    if (!BANK_KINDS.includes(bank)) continue;
    for (let i = 0; i < r.n; i++) refs.push({ bank, annexItem: r.item, aspect: r.aspect });
  }
  return refs;
}

export interface BankCoverageReport extends BankCoverage {
  label: string;
  /** 只靠导入、平台不预置且数量仍未达标的小项（2026.11.4 起为空）。 */
  pendingImportLabels: string[];
}

export async function computeBankCoverage(db: PrismaClient): Promise<BankCoverageReport[]> {
  const refs = countsToRefs(await loadBankQuestionCounts(db));
  return BANK_KINDS.map((bank) => {
    const c = evaluateBankCoverage(bank, refs);
    return {
      ...c,
      label: BANK_LABELS[bank],
      pendingImportLabels: c.pendingImportItems.length ? [...c.pendingImportItems] : [],
    };
  });
}

export { IMPORT_ONLY_ITEMS };
