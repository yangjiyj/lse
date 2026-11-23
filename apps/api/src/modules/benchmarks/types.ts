import type { Severity, QuestionType } from '@lse/shared';

/**
 * 归一化后的基准题目——与 question-import 的 ParsedQuestion 同构，
 * 因此可直接喂入题集导入流程（createMany）。
 */
export interface NormalizedBenchmarkItem {
  externalId: string | null;
  content: string;
  category: string | null;
  expectedBehavior: string | null;
  referenceAnswer: string | null;
  severity: Severity | null;
  tags: string[];
  type: QuestionType;
  shouldRefuse: boolean;
  /** 溯源信息（原始 ID、来源、分类等），写入 Question.metadata；可选。 */
  metadata?: Record<string, unknown> | null;
}

export interface BenchmarkIssue {
  /** 1-based 行号（CSV 含表头；JSON/JSONL 为元素序号/文件行号）。 */
  row: number;
  level: 'error' | 'warning';
  message: string;
}

/** 适配器内部产生的问题（行号由核心 parseBenchmark 统一补充）。 */
export interface MapIssue {
  level: 'error' | 'warning';
  message: string;
}

export type BenchmarkInputKind = 'json' | 'jsonl' | 'csv';

/** 解码后的单条原始记录：键为原始字段名，值统一字符串化。 */
export type RawRecord = Record<string, string>;

export interface MapRecordResult {
  item: NormalizedBenchmarkItem | null;
  issues: MapIssue[];
}

export interface BenchmarkAdapter {
  id: string;
  label: string;
  description: string;
  inputKind: BenchmarkInputKind;
  /** 公开基准的展示元信息（可选）：出处、典型文件名、期望表头、许可提示、使用提示。 */
  origin?: string;
  typicalFiles?: string;
  expectedHeaders?: string;
  licenseNote?: string;
  usageNote?: string;
  /** 必需字段：每组为一组等价别名，至少命中一个，否则判定表头缺失。 */
  requiredFields?: string[][];
  mapRecord(rec: RawRecord): MapRecordResult;
}

/** 对外可序列化的适配器元信息（不含函数）。 */
export interface BenchmarkAdapterInfo {
  id: string;
  label: string;
  description: string;
  inputKind: BenchmarkInputKind;
  origin?: string;
  typicalFiles?: string;
  expectedHeaders?: string;
  licenseNote?: string;
  usageNote?: string;
}

export interface BenchmarkParseResult {
  formatId: string;
  items: NormalizedBenchmarkItem[];
  issues: BenchmarkIssue[];
  totalRows: number;
  importedRows: number;
  failedRows: number;
  /** 按题面去重时被丢弃的重复题数（不计入 failedRows）。 */
  duplicateRows?: number;
}
