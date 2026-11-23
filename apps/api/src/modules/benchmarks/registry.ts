import { parseCsv } from '../../lib/question-import.js';
import { ADAPTERS, normKey } from './adapters.js';
import type {
  BenchmarkAdapter,
  BenchmarkAdapterInfo,
  BenchmarkInputKind,
  BenchmarkIssue,
  BenchmarkParseResult,
  NormalizedBenchmarkItem,
  RawRecord,
} from './types.js';

const REGISTRY = new Map<string, BenchmarkAdapter>();
for (const a of ADAPTERS) REGISTRY.set(a.id, a);

export const BENCHMARK_FORMAT_IDS: readonly string[] = ADAPTERS.map((a) => a.id);

export function getBenchmarkAdapter(id: string): BenchmarkAdapter | undefined {
  return REGISTRY.get(id);
}

export function listBenchmarkAdapters(): BenchmarkAdapterInfo[] {
  return ADAPTERS.map(
    ({
      id,
      label,
      description,
      inputKind,
      origin,
      typicalFiles,
      expectedHeaders,
      licenseNote,
      usageNote,
    }) => ({
      id,
      label,
      description,
      inputKind,
      ...(origin ? { origin } : {}),
      ...(typicalFiles ? { typicalFiles } : {}),
      ...(expectedHeaders ? { expectedHeaders } : {}),
      ...(licenseNote ? { licenseNote } : {}),
      ...(usageNote ? { usageNote } : {}),
    }),
  );
}

interface DecodedRecord {
  record: RawRecord;
  row: number;
}
interface DecodeResult {
  records: DecodedRecord[];
  issues: BenchmarkIssue[];
}

function toRecord(obj: unknown): RawRecord {
  const out: RawRecord = {};
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v == null) out[k] = '';
    else if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    else out[k] = JSON.stringify(v);
  }
  return out;
}

function decodeJson(text: string): DecodeResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      records: [],
      issues: [{ row: 0, level: 'error', message: 'JSON 解析失败：文件不是合法 JSON' }],
    };
  }
  let arr: unknown[];
  if (Array.isArray(data)) {
    arr = data;
  } else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const key = ['data', 'questions', 'items', 'samples', 'rows'].find((k) =>
      Array.isArray(obj[k]),
    );
    arr = key ? (obj[key] as unknown[]) : [obj];
  } else {
    return {
      records: [],
      issues: [
        { row: 0, level: 'error', message: 'JSON 结构无法识别：应为数组或包含数组字段的对象' },
      ],
    };
  }
  return { records: arr.map((el, i) => ({ record: toRecord(el), row: i + 1 })), issues: [] };
}

function decodeJsonl(text: string): DecodeResult {
  const issues: BenchmarkIssue[] = [];
  const records: DecodedRecord[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const row = i + 1;
    if (line.trim() === '') return; // 空行跳过、不计数
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      issues.push({ row, level: 'error', message: `第 ${row} 行不是合法 JSON，已跳过` });
      return;
    }
    records.push({ record: toRecord(obj), row });
  });
  return { records, issues };
}

function decodeCsv(text: string): DecodeResult {
  const rows = parseCsv(text);
  const headers = rows[0];
  if (!headers) return { records: [], issues: [] };
  const records: DecodedRecord[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (!cells || cells.every((c) => (c ?? '').trim() === '')) continue; // 全空行跳过、不计数
    const record: RawRecord = {};
    headers.forEach((h, c) => {
      record[h] = cells[c] ?? '';
    });
    records.push({ record, row: r + 1 });
  }
  return { records, issues: [] };
}

function decodeByKind(text: string, kind: BenchmarkInputKind): DecodeResult {
  switch (kind) {
    case 'json':
      return decodeJson(text);
    case 'jsonl':
      return decodeJsonl(text);
    case 'csv':
      return decodeCsv(text);
  }
}

/** 解码文本：优先 UTF-8（去 BOM）；非法 UTF-8 时回退 GB18030（常见于 Excel 另存的中文 CSV）。 */
function decodeText(raw: Buffer | string): { text: string; issues: BenchmarkIssue[] } {
  if (typeof raw === 'string') return { text: raw.replace(/^\uFEFF/, ''), issues: [] };
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    return { text: text.replace(/^\uFEFF/, ''), issues: [] };
  } catch {
    try {
      const text = new TextDecoder('gb18030', { fatal: true }).decode(raw);
      return {
        text: text.replace(/^\uFEFF/, ''),
        issues: [{ row: 0, level: 'warning', message: '文件不是 UTF-8 编码，已按 GB18030 解码' }],
      };
    } catch {
      return {
        text: raw.toString('utf8'),
        issues: [
          {
            row: 0,
            level: 'warning',
            message: '文件编码无法识别，已按 UTF-8 宽松解码，可能出现乱码',
          },
        ],
      };
    }
  }
}

function normContent(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 检查必需表头；返回缺失说明（无缺失返回 null）。 */
function missingHeaders(records: DecodedRecord[], groups: string[][] | undefined): string | null {
  if (!groups || records.length === 0) return null;
  const keys = new Set<string>();
  for (const { record } of records.slice(0, 200)) {
    for (const k of Object.keys(record)) keys.add(normKey(k));
  }
  const missing = groups.filter((g) => !g.some((a) => keys.has(normKey(a))));
  if (missing.length === 0) return null;
  return missing.map((g) => g.join(' / ')).join('、');
}

export function parseBenchmark(raw: Buffer | string, formatId: string): BenchmarkParseResult {
  const adapter = getBenchmarkAdapter(formatId);
  if (!adapter) throw new Error(`未知的基准格式: ${formatId}`);
  const { text, issues: decodeIssues } = decodeText(raw);
  const decoded = decodeByKind(text, adapter.inputKind);
  const issues: BenchmarkIssue[] = [...decodeIssues, ...decoded.issues];
  const items: NormalizedBenchmarkItem[] = [];
  let totalRows = 0;
  let failedRows = 0;
  let duplicateRows = 0;

  const missing = missingHeaders(decoded.records, adapter.requiredFields);
  if (missing) {
    issues.push({
      row: 0,
      level: 'error',
      message: `缺少必需表头/字段：${missing}。期望表头：${adapter.expectedHeaders ?? '见格式说明'}`,
    });
    return {
      formatId,
      items,
      issues,
      totalRows: decoded.records.length,
      importedRows: 0,
      failedRows: decoded.records.length,
      duplicateRows: 0,
    };
  }

  const seen = new Set<string>();
  for (const { record, row } of decoded.records) {
    totalRows++;
    const mapped = adapter.mapRecord(record);
    for (const it of mapped.issues) issues.push({ row, level: it.level, message: it.message });
    if (!mapped.item) {
      failedRows++;
      continue;
    }
    const key = normContent(mapped.item.content);
    if (seen.has(key)) {
      duplicateRows++;
      issues.push({ row, level: 'warning', message: '题面与前面的题目重复，已去重' });
      continue;
    }
    seen.add(key);
    items.push(mapped.item);
  }
  return {
    formatId,
    items,
    issues,
    totalRows,
    importedRows: items.length,
    failedRows,
    duplicateRows,
  };
}
