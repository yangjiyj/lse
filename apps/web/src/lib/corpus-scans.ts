import { downloadFile, request, uploadOctetStream } from '@/lib/api';

// 语料扫描与语料规则（数据安全）的前端类型与请求，对应 apps/api/src/modules/corpus-scans。

export type CorpusFormat =
  | 'auto'
  | 'alpaca'
  | 'sharegpt'
  | 'messages'
  | 'prompt_completion'
  | 'chosen_rejected'
  | 'csv'
  | 'txt';

export const CORPUS_FORMAT_OPTIONS: Array<{ value: CorpusFormat; label: string }> = [
  { value: 'auto', label: '自动识别' },
  { value: 'alpaca', label: 'Alpaca' },
  { value: 'sharegpt', label: 'ShareGPT' },
  { value: 'messages', label: 'OpenAI messages' },
  { value: 'prompt_completion', label: 'prompt/completion' },
  { value: 'chosen_rejected', label: 'chosen/rejected' },
  { value: 'csv', label: 'CSV' },
  { value: 'txt', label: '纯文本' },
];

export const DETECTED_FORMAT_LABELS: Record<string, string> = {
  alpaca: 'Alpaca',
  sharegpt: 'ShareGPT',
  messages: 'OpenAI messages',
  prompt_completion: 'prompt/completion',
  chosen_rejected: 'chosen/rejected',
  generic: '通用 JSON',
  csv: 'CSV',
  txt: '纯文本',
};

export type FindingCategory = 'violation' | 'sensitive' | 'custom';
export const FINDING_CATEGORY_LABELS: Record<FindingCategory, string> = {
  violation: '违规内容',
  sensitive: '敏感信息',
  custom: '自定义规则',
};

export type RuleSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export const RULE_SEVERITY_OPTIONS: Array<{ value: RuleSeverity; label: string }> = [
  { value: 'CRITICAL', label: '严重' },
  { value: 'HIGH', label: '高' },
  { value: 'MEDIUM', label: '中' },
  { value: 'LOW', label: '低' },
];

export const JUDGE_VERDICT_LABELS: Record<string, string> = {
  CONFIRMED: '确认违规',
  DISMISSED: '判为误报',
  ERROR: '复核失败',
};

export type CorpusScanStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface CorpusScanStats {
  container: string | null;
  detectedFormat: string | null;
  totalRecords: number;
  invalidRecords: number;
  invalidSamples: Array<{ line: number; reason: string }>;
  schemaCounts: Record<string, number>;
  findingCount: number;
  recordsWithFindings: number;
  byCategory: Record<FindingCategory, number>;
  bySubtype: Array<{
    category: FindingCategory;
    subtype: string;
    label: string | null;
    count: number;
  }>;
  /** 单条记录同类命中超过 1000 条、只计数没保存的条数 */
  cappedFindings?: number;
  regexTimeouts: number;
  /** 超时 3 次后停用的自定义正则 */
  disabledRules?: Array<{ ruleId: string; pattern: string; category: string }>;
  /** 超过 10 万字、自定义正则只检查了前 10 万字的字段数 */
  regexTruncatedFields?: number;
  /** 超过 500 条、没有参与的自定义正则数 */
  regexRulesIgnored?: number;
}

export interface CorpusScanView {
  id: string;
  fileName: string;
  bytes: number;
  sha256: string;
  format: CorpusFormat;
  detectedFormat: string | null;
  container: string | null;
  csvColumns: string[] | null;
  ruleSet: { id: string; name: string } | null;
  judgeReview: boolean;
  judgeLimit: number;
  status: CorpusScanStatus;
  error: string | null;
  progressBytes: number;
  totalRecords: number;
  invalidRecords: number;
  findingCount: number;
  storedFindings: number;
  truncated: boolean;
  stats: CorpusScanStats | null;
  judgeReviewed: number;
  judgeNote: string | null;
  /** 打码副本已生成、文件还在 */
  maskedCopyReady: boolean;
  /** 原文件和打码副本超过保留期限被清理的时间 */
  filesPurgedAt: string | null;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CorpusFindingView {
  id: string;
  recordIndex: number;
  line: number;
  fieldPath: string;
  category: FindingCategory;
  subtype: string;
  subtypeLabel: string | null;
  matchText: string;
  contextBefore: string;
  contextAfter: string;
  severity: RuleSeverity;
  judgeVerdict: string | null;
  judgeReason: string | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreateCorpusScanOptions {
  format: CorpusFormat;
  ruleSetId: string | null;
  judgeReview: boolean;
  judgeLimit: number;
  /** CSV 要检测的列，空为全部列 */
  csvColumns: string[];
}

export interface CorpusRuleSetView {
  id: string;
  name: string;
  description: string | null;
  ruleCount: number;
  enabledCount: number;
  createdAt: string;
  updatedAt: string;
}

export type RuleKind = 'keyword' | 'regex';

export interface CorpusRuleView {
  id: string;
  ruleSetId: string;
  kind: RuleKind;
  pattern: string;
  category: string;
  severity: RuleSeverity;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CorpusRuleInput {
  kind: RuleKind;
  pattern: string;
  category: string;
  severity: RuleSeverity;
  enabled: boolean;
}

export interface CorpusRuleImportResult {
  totalRows: number;
  added: number;
  duplicates: number;
  failed: number;
  issues: Array<{ row: number; message: string }>;
}

/** 上传上限的写法：整 MiB 写成「500 MiB」 */
export function formatLimit(bytes: number): string {
  const mib = 1024 * 1024;
  return bytes >= mib && bytes % mib === 0 ? `${bytes / mib} MiB` : formatBytes(bytes);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 列表和详情里显示的格式：识别出的优先，其次是选的格式。 */
export function scanFormatLabel(s: Pick<CorpusScanView, 'format' | 'detectedFormat'>): string {
  if (s.detectedFormat) return DETECTED_FORMAT_LABELS[s.detectedFormat] ?? s.detectedFormat;
  return CORPUS_FORMAT_OPTIONS.find((o) => o.value === s.format)?.label ?? s.format;
}

/** 打码副本的文件名：train.jsonl → train.masked.jsonl */
export function maskedFileName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? `${fileName.slice(0, dot)}.masked${fileName.slice(dot)}` : `${fileName}.masked`;
}

export const corpusScansApi = {
  /** 列表顺带返回上传上限（字节），新建扫描时提示用 */
  list(query: { page?: number; pageSize?: number; status?: CorpusScanStatus } = {}) {
    return request<Page<CorpusScanView> & { uploadMaxBytes: number }>('GET', '/corpus-scans', {
      query,
    });
  },
  get(id: string) {
    return request<CorpusScanView>('GET', `/corpus-scans/${encodeURIComponent(id)}`);
  },
  findings(
    id: string,
    query: { category?: FindingCategory; subtype?: string; page?: number; pageSize?: number },
  ) {
    return request<Page<CorpusFindingView>>(
      'GET',
      `/corpus-scans/${encodeURIComponent(id)}/findings`,
      { query },
    );
  },
  /** 原始字节上传（application/octet-stream），文件名和选项走 query。 */
  create(file: File, opts: CreateCorpusScanOptions) {
    return uploadOctetStream<{ id: string; status: CorpusScanStatus }>(
      '/corpus-scans',
      {
        fileName: file.name,
        format: opts.format,
        ruleSetId: opts.ruleSetId,
        judgeReview: opts.judgeReview,
        judgeLimit: opts.judgeReview ? opts.judgeLimit : undefined,
        csvColumns: opts.csvColumns.length > 0 ? opts.csvColumns.join(',') : undefined,
      },
      file,
    );
  },
  remove(id: string) {
    return request<{ deleted: true }>('DELETE', `/corpus-scans/${encodeURIComponent(id)}`);
  },
  exportFindings(id: string, format: 'csv' | 'json') {
    return downloadFile(
      `/corpus-scans/${encodeURIComponent(id)}/export`,
      { format },
      `corpus-scan.${format}`,
    );
  },
  maskedCopy(id: string, fileName: string) {
    return downloadFile(`/corpus-scans/${encodeURIComponent(id)}/masked-copy`, undefined, fileName);
  },
};

export const corpusRulesApi = {
  listSets() {
    return request<{ items: CorpusRuleSetView[] }>('GET', '/corpus-rules/sets');
  },
  createSet(body: { name: string; description?: string | null }) {
    return request<CorpusRuleSetView>('POST', '/corpus-rules/sets', { body });
  },
  updateSet(id: string, body: { name?: string; description?: string | null }) {
    return request<CorpusRuleSetView>('PATCH', `/corpus-rules/sets/${encodeURIComponent(id)}`, {
      body,
    });
  },
  deleteSet(id: string) {
    return request<{ deleted: true }>('DELETE', `/corpus-rules/sets/${encodeURIComponent(id)}`);
  },
  listRules(
    setId: string,
    query: { kind?: RuleKind; q?: string; page?: number; pageSize?: number } = {},
  ) {
    return request<Page<CorpusRuleView>>(
      'GET',
      `/corpus-rules/sets/${encodeURIComponent(setId)}/rules`,
      { query },
    );
  },
  createRule(setId: string, body: CorpusRuleInput) {
    return request<CorpusRuleView>(
      'POST',
      `/corpus-rules/sets/${encodeURIComponent(setId)}/rules`,
      { body },
    );
  },
  updateRule(id: string, body: Partial<CorpusRuleInput>) {
    return request<CorpusRuleView>('PATCH', `/corpus-rules/rules/${encodeURIComponent(id)}`, {
      body,
    });
  },
  deleteRule(id: string) {
    return request<{ deleted: true }>('DELETE', `/corpus-rules/rules/${encodeURIComponent(id)}`);
  },
  importRules(
    setId: string,
    file: File,
    opts: {
      format: 'csv' | 'xlsx' | 'txt';
      category?: string;
      severity?: RuleSeverity;
      kind?: RuleKind;
    },
  ) {
    return uploadOctetStream<CorpusRuleImportResult>(
      `/corpus-rules/sets/${encodeURIComponent(setId)}/import`,
      { format: opts.format, category: opts.category, severity: opts.severity, kind: opts.kind },
      file,
    );
  },
};
