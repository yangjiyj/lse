// 题库导入解析与映射：xlsx(exceljs) / csv(自研 RFC4180) -> 归一化题目。纯函数，便于单测。
import ExcelJS from 'exceljs';
import {
  CSV_WATERMARK_PREFIX,
  applyWorkbookWatermark,
  csvWatermarkLine,
  type DownloadWatermark,
} from './data-security.js';
import {
  QUESTION_TEMPLATES,
  normalizeSeverity,
  parseTags,
  type QuestionTemplateType,
  type TemplateField,
} from '@lse/shared';
import { QUESTION_TEMPLATE_TYPES, type QuestionType, type Severity } from '@lse/shared';
import { csvCell, restoreFormula } from './tabular-export.js';

export type ImportFormat = 'xlsx' | 'csv';

export interface ParsedQuestion {
  externalId: string | null;
  content: string;
  category: string | null;
  expectedBehavior: string | null;
  referenceAnswer: string | null;
  severity: Severity | null;
  tags: string[];
  type: QuestionType;
  shouldRefuse: boolean;
  /** 条目编码（导出文件的「条目编码」列）：{ clauseIds, annexItem }。 */
  metadata?: Record<string, unknown> | null;
}

export interface RowIssue {
  row: number; // 1-based，含表头（与电子表格行号一致）
  level: 'error' | 'warning';
  message: string;
}

export interface MapResult {
  missingHeaders: string[]; // 缺失的必需列（规范表头名）
  parsed: ParsedQuestion[];
  issues: RowIssue[];
  totalRows: number; // 参与映射的数据行（含失败，不含空行）
  importedRows: number;
  failedRows: number;
}

/** RFC4180 CSV 解析：支持引号转义、字段内逗号/换行、CRLF、UTF-8 BOM。 */
export function parseCsv(input: string): string[][] {
  const s = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function cellText(cell: ExcelJS.Cell): string {
  const t = cell.text;
  return t == null ? '' : String(t);
}

export interface TabularSheet {
  name: string;
  rows: string[][];
}

/** 读取 xlsx 的全部工作表（按工作簿顺序），每个表为二维字符串数组。 */
export async function parseXlsxSheets(buffer: Buffer): Promise<TabularSheet[]> {
  const wb = new ExcelJS.Workbook();
  // exceljs 接受 Buffer；类型签名要求 ArrayBuffer-like，做一次断言。
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb.worksheets.map((ws) => {
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const arr: string[] = [];
      const n = row.cellCount;
      for (let c = 1; c <= n; c++) {
        arr.push(cellText(row.getCell(c)));
      }
      rows.push(arr);
    });
    return { name: ws.name, rows };
  });
}

/** 读取 xlsx 首个工作表为二维字符串数组。 */
export async function parseXlsx(buffer: Buffer): Promise<string[][]> {
  return (await parseXlsxSheets(buffer))[0]?.rows ?? [];
}

export async function parseTabular(buffer: Buffer, format: ImportFormat): Promise<string[][]> {
  return (await parseTabularSheets(buffer, format))[0]?.rows ?? [];
}

/** 导入用：csv 只有一个表；xlsx 读全部工作表。 */
export async function parseTabularSheets(
  buffer: Buffer,
  format: ImportFormat,
): Promise<TabularSheet[]> {
  if (format === 'csv') {
    // 下载模板首行可能是水印行，回填导入时忽略。
    const rows = parseCsv(buffer.toString('utf8'));
    return [
      { name: '', rows: rows[0]?.[0]?.startsWith(CSV_WATERMARK_PREFIX) ? rows.slice(1) : rows },
    ];
  }
  return parseXlsxSheets(buffer);
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, '');
}

/** 导入模板之外、导出时追加的列；导入时能认出来，缺了不影响（来源数据集、许可导入时忽略）。 */
type ExtraField =
  | 'expectedBehavior'
  | 'referenceAnswer'
  | 'shouldRefuse'
  | 'clauseIds'
  | 'dataset'
  | 'license';

interface ExtraColumn {
  field: ExtraField;
  header: string;
  aliases: string[];
}

const EXTRA_COLUMNS: ExtraColumn[] = [
  {
    field: 'expectedBehavior',
    header: '预期表现',
    aliases: ['预期行为', '期望表现', 'expected', 'expected_behavior'],
  },
  {
    field: 'referenceAnswer',
    header: '参考答案',
    aliases: ['参考拒答', '标准答案', '标准拒答', 'reference', 'reference_answer'],
  },
  { field: 'shouldRefuse', header: '应拒答', aliases: ['should_refuse', 'shouldrefuse'] },
  { field: 'clauseIds', header: '条目编码', aliases: ['条款编码', 'clause_ids', 'clauseids'] },
  { field: 'dataset', header: '来源数据集', aliases: ['dataset'] },
  { field: 'license', header: '许可', aliases: ['license'] },
];

/** 某模板追加哪些列：模板里没有的预期表现、参考答案，再加应拒答、条目编码、来源数据集、许可。 */
function extraColumnsFor(templateType: QuestionTemplateType): ExtraColumn[] {
  const own = new Set<string>(QUESTION_TEMPLATES[templateType].columns.map((c) => c.field));
  return EXTRA_COLUMNS.filter((c) => !own.has(c.field));
}

const SHOULD_REFUSE_VALUES: Record<string, boolean> = {
  是: true,
  否: false,
  true: true,
  false: false,
  yes: true,
  no: false,
  y: true,
  n: false,
  '1': true,
  '0': false,
};

/** 条目编码列 → clauseIds；附录 A 小项取第一个 gbt45654.A.* 条款（与标准评估的取法一致）。 */
function clauseMetadata(raw: string): Record<string, unknown> | null {
  const clauseIds = [
    ...new Set(
      raw
        .split(/[,，;；\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (clauseIds.length === 0) return null;
  const annex = clauseIds.find((id) => id.startsWith('gbt45654.A.'));
  return { clauseIds, annexItem: annex ? annex.slice('gbt45654.'.length) : null };
}

/** 将解析出的二维数组按模板映射为题目，并收集行级问题。 */
export function mapRows(rows: string[][], templateType: QuestionTemplateType): MapResult {
  const def = QUESTION_TEMPLATES[templateType];
  const requiredHeaders = def.columns.filter((c) => c.required).map((c) => c.header);

  if (rows.length === 0) {
    return {
      missingHeaders: requiredHeaders,
      parsed: [],
      issues: [],
      totalRows: 0,
      importedRows: 0,
      failedRows: 0,
    };
  }

  const header = (rows[0] ?? []).map(normalizeHeader);
  const colOf: Partial<Record<TemplateField, number>> = {};
  for (const col of def.columns) {
    const names = [col.header, ...col.aliases].map(normalizeHeader);
    const idx = header.findIndex((h) => names.includes(h));
    if (idx >= 0) colOf[col.field] = idx;
  }
  const used = new Set(Object.values(colOf));
  const extraOf: Partial<Record<ExtraField, number>> = {};
  for (const col of extraColumnsFor(templateType)) {
    const names = [col.header, ...col.aliases].map(normalizeHeader);
    const idx = header.findIndex((h, i) => names.includes(h) && !used.has(i));
    if (idx >= 0) extraOf[col.field] = idx;
  }

  const missingHeaders = def.columns
    .filter((c) => c.required && colOf[c.field] === undefined)
    .map((c) => c.header);
  if (missingHeaders.length > 0) {
    return { missingHeaders, parsed: [], issues: [], totalRows: 0, importedRows: 0, failedRows: 0 };
  }

  const parsed: ParsedQuestion[] = [];
  const issues: RowIssue[] = [];
  let failedRows = 0;
  let totalRows = 0;

  // CSV 导出给公式触发字符开头的文本加了 `'`，导入时去掉，保证往返一致。
  const cellAt = (row: string[], field: TemplateField): string => {
    const idx = colOf[field];
    if (idx === undefined) return '';
    return restoreFormula(row[idx] ?? '').trim();
  };
  const extraAt = (row: string[], field: ExtraField): string => {
    const idx = extraOf[field];
    if (idx === undefined) return '';
    return restoreFormula(row[idx] ?? '').trim();
  };

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const lineNo = r + 1;
    const hasAnyData = row.some((c) => (c ?? '').trim() !== '');
    if (!hasAnyData) continue; // 跳过完全空行

    totalRows++;
    const content = cellAt(row, 'content');
    if (!content) {
      failedRows++;
      issues.push({ row: lineNo, level: 'error', message: '缺少必填的问题内容' });
      continue;
    }

    const sevRaw = cellAt(row, 'severity');
    let severity: Severity | null = null;
    if (sevRaw) {
      severity = normalizeSeverity(sevRaw);
      if (!severity) {
        issues.push({
          row: lineNo,
          level: 'warning',
          message: `无法识别的风险等级"${sevRaw}"，已置空`,
        });
      }
    }

    let shouldRefuse = def.shouldRefuse;
    const refuseRaw = extraAt(row, 'shouldRefuse');
    if (refuseRaw) {
      const v = SHOULD_REFUSE_VALUES[refuseRaw.toLowerCase()];
      if (v === undefined) {
        issues.push({
          row: lineNo,
          level: 'warning',
          message: `无法识别的应拒答"${refuseRaw}"，按模板默认处理`,
        });
      } else {
        shouldRefuse = v;
      }
    }

    parsed.push({
      externalId: cellAt(row, 'externalId') || null,
      content,
      category: cellAt(row, 'category') || null,
      expectedBehavior: cellAt(row, 'expectedBehavior') || extraAt(row, 'expectedBehavior') || null,
      referenceAnswer: cellAt(row, 'referenceAnswer') || extraAt(row, 'referenceAnswer') || null,
      severity,
      tags: parseTags(cellAt(row, 'tags')),
      type: def.questionType,
      shouldRefuse,
      metadata: clauseMetadata(extraAt(row, 'clauseIds')),
    });
  }

  return { missingHeaders: [], parsed, issues, totalRows, importedRows: parsed.length, failedRows };
}

const TEMPLATE_BY_LABEL = new Map<string, QuestionTemplateType>(
  QUESTION_TEMPLATE_TYPES.map((t) => [QUESTION_TEMPLATES[t].label, t]),
);

/**
 * 导入整本文件：xlsx 里有两个及以上以模板名命名的工作表（题型混合的样本库导出）时，
 * 每个表按表名对应的模板导入；否则只读首个工作表、按所选模板导入（与原来一致）。
 */
export function mapSheets(sheets: TabularSheet[], templateType: QuestionTemplateType): MapResult {
  const labeled = sheets.filter((s) => TEMPLATE_BY_LABEL.has(s.name) && s.rows.length > 0);
  if (labeled.length < 2) return mapRows(sheets[0]?.rows ?? [], templateType);
  const merged: MapResult = {
    missingHeaders: [],
    parsed: [],
    issues: [],
    totalRows: 0,
    importedRows: 0,
    failedRows: 0,
  };
  for (const sheet of labeled) {
    const r = mapRows(sheet.rows, TEMPLATE_BY_LABEL.get(sheet.name)!);
    merged.missingHeaders.push(...r.missingHeaders.map((h) => `${sheet.name}：${h}`));
    merged.parsed.push(...r.parsed);
    merged.issues.push(
      ...r.issues.map((i) => ({ ...i, message: `「${sheet.name}」${i.message}` })),
    );
    merged.totalRows += r.totalRows;
    merged.importedRows += r.importedRows;
    merged.failedRows += r.failedRows;
  }
  return merged;
}

/** 生成模板文件（表头 + 一行示例）。 */
export async function buildTemplateFile(
  templateType: QuestionTemplateType,
  format: ImportFormat,
  watermark?: DownloadWatermark | null,
): Promise<Buffer> {
  const def = QUESTION_TEMPLATES[templateType];
  return buildSheetsFile(
    [
      {
        name: def.label,
        header: def.columns.map((c) => c.header),
        rows: [def.columns.map((c) => c.example)],
      },
    ],
    format,
    watermark,
  );
}

/** 样本库题型 → 导入模板（导出时按每道题自身的题型出列，导出的文件能按同一模板导回去）。 */
export const TEMPLATE_BY_QUESTION_TYPE: Record<QuestionType, QuestionTemplateType> = {
  COMPLIANCE: 'compliance',
  PROMPT_INJECTION: 'prompt_injection',
  SHOULD_REFUSE: 'should_refuse',
  GENERAL: 'general',
};

export interface ExportableQuestion {
  externalId: string | null;
  content: string;
  category: string | null;
  expectedBehavior: string | null;
  referenceAnswer: string | null;
  severity: Severity | null;
  tags: string[];
  type: QuestionType;
  shouldRefuse: boolean;
  metadata: unknown;
}

export interface QuestionExportGroup {
  templateType: QuestionTemplateType;
  questions: ExportableQuestion[];
}

function metaOf(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

function extraCell(field: ExtraField, q: ExportableQuestion): string {
  const meta = metaOf(q.metadata);
  switch (field) {
    case 'expectedBehavior':
      return q.expectedBehavior ?? '';
    case 'referenceAnswer':
      return q.referenceAnswer ?? '';
    case 'shouldRefuse':
      return q.shouldRefuse ? '是' : '否';
    case 'clauseIds':
      return Array.isArray(meta.clauseIds)
        ? meta.clauseIds.filter((x): x is string => typeof x === 'string').join(',')
        : '';
    case 'dataset':
      return typeof meta.dataset === 'string' ? meta.dataset : '';
    case 'license':
      return typeof meta.license === 'string' ? meta.license : '';
  }
}

/** 导出表头：导入模板的列 + 追加列。 */
export function questionExportHeader(templateType: QuestionTemplateType): string[] {
  return [
    ...QUESTION_TEMPLATES[templateType].columns.map((c) => c.header),
    ...extraColumnsFor(templateType).map((c) => c.header),
  ];
}

/** 一道题按导出表头的列顺序转成一行。 */
export function questionExportRow(
  templateType: QuestionTemplateType,
  q: ExportableQuestion,
): string[] {
  return [
    ...QUESTION_TEMPLATES[templateType].columns.map((c) => {
      if (c.field === 'tags') return q.tags.join(',');
      return q[c.field] ?? '';
    }),
    ...extraColumnsFor(templateType).map((c) => extraCell(c.field, q)),
  ];
}

/** 按题型分组，每种题型对应一个导入模板（工作表），顺序同模板列表；空库按样本库题型给一个空表。 */
export function groupQuestionsForExport(
  questions: ExportableQuestion[],
  setType: QuestionType,
): QuestionExportGroup[] {
  const byTemplate = new Map<QuestionTemplateType, ExportableQuestion[]>();
  for (const q of questions) {
    const t = TEMPLATE_BY_QUESTION_TYPE[q.type];
    const list = byTemplate.get(t) ?? [];
    list.push(q);
    byTemplate.set(t, list);
  }
  if (byTemplate.size === 0)
    return [{ templateType: TEMPLATE_BY_QUESTION_TYPE[setType], questions: [] }];
  return QUESTION_TEMPLATE_TYPES.filter((t) => byTemplate.has(t)).map((t) => ({
    templateType: t,
    questions: byTemplate.get(t)!,
  }));
}

/** 样本库导出文件：xlsx 每组一个工作表（表名 = 模板名，导入时按表名认模板）；csv 只能有一组。 */
export async function buildQuestionExport(
  groups: QuestionExportGroup[],
  format: ImportFormat,
  watermark?: DownloadWatermark | null,
): Promise<Buffer> {
  return buildSheetsFile(
    groups.map((g) => ({
      name: QUESTION_TEMPLATES[g.templateType].label,
      header: questionExportHeader(g.templateType),
      rows: g.questions.map((q) => questionExportRow(g.templateType, q)),
    })),
    format,
    watermark,
  );
}

/** 生成 xlsx / csv：csv 带 UTF-8 BOM、防公式注入，水印在首行（导入时会跳过）。 */
async function buildSheetsFile(
  sheets: Array<{ name: string; header: string[]; rows: string[][] }>,
  format: ImportFormat,
  watermark?: DownloadWatermark | null,
): Promise<Buffer> {
  if (format === 'csv') {
    if (sheets.length !== 1) throw new Error('CSV 只能导出一个工作表');
    const { header, rows } = sheets[0]!;
    const lines = [header, ...rows].map((r) => r.map(csvCell).join(','));
    if (watermark) lines.unshift(csvWatermarkLine(watermark));
    // 加 UTF-8 BOM，避免 Excel 打开中文乱码
    return Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(lines.join('\r\n'), 'utf8'),
    ]);
  }

  const wb = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name);
    ws.addRow(sheet.header);
    for (const row of sheet.rows) ws.addRow(row);
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((col) => {
      col.width = 24;
    });
  }
  if (watermark) applyWorkbookWatermark(wb, watermark);
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
