// 语料扫描核心：逐条记录跑三类检测——违规内容（国标关键词自动机，1.2.1、1.2.4）、敏感信息（1.2.2）、
// 自定义规则（1.2.3），产出命中（原文不打码，前后各 40 字上下文）和统计。
// 服务端 worker 和命令行版都用 createScanSession，统计口径一致。纯函数，只用可擦除的 TS 语法。
//
// 一个读块解析出的记录一起处理：自定义正则整批进一次 vm（分片执行），其余检测逐条做。
// pushAsync / endAsync 在分片之间、记录之间每隔 YIELD_MS 让出一次事件循环（服务端 worker 用，进度上报、
// 心跳不会被一个大块卡住）；push / end 是同步版本（测试和小样本用），结果完全一样。
import {
  createCorpusParser,
  type Container,
  type ParsedItem,
  type ParserOptions,
  type RecordSchema,
} from './formats.ts';
import { buildKeywordAutomaton, type KeywordEntry } from './keyword-matcher.ts';
import { SENSITIVE_LABELS, findSensitive } from './sensitive-rules.ts';
import {
  compileCustomRules,
  type CustomHit,
  type CustomRule,
  type DisabledRule,
} from './custom-rules.ts';

export const FINDING_CATEGORIES = ['violation', 'sensitive', 'custom'] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];
export const FINDING_CATEGORY_LABELS: Record<FindingCategory, string> = {
  violation: '违规内容',
  sensitive: '敏感信息',
  custom: '自定义规则',
};

export const CONTEXT_CHARS = 40;
/** 命中原文最多保留的字符数（私钥块这类很长的命中截断） */
export const MATCH_TEXT_MAX = 4000;
/** 每次扫描最多保存的命中条数，超出只计数 */
export const MAX_STORED_FINDINGS = 50_000;
/** 单条记录每个类别最多输出的命中条数，超出只计数 */
export const RECORD_CATEGORY_MAX = 1000;
/** 统计里保留的非法行样例数 */
export const INVALID_SAMPLE_MAX = 100;
export const VIOLATION_SEVERITY = 'HIGH';
/** 异步处理时最长连续占用事件循环的时间 */
export const YIELD_MS = 50;

export interface CorpusFindingOut {
  recordIndex: number;
  line: number;
  fieldPath: string;
  category: FindingCategory;
  /** 违规：条目编码；敏感：类型；自定义：规则类别名 */
  subtype: string;
  subtypeLabel: string | null;
  ruleId: string | null;
  matchText: string;
  contextBefore: string;
  contextAfter: string;
  severity: string;
}

export interface SubtypeCount {
  category: FindingCategory;
  subtype: string;
  label: string | null;
  count: number;
}

export interface ScanStats {
  container: Container | null;
  detectedFormat: RecordSchema | null;
  /** 记录总数（含非法） */
  totalRecords: number;
  invalidRecords: number;
  invalidSamples: { line: number; reason: string }[];
  /** 各格式的记录数（自动识别时每条单独认） */
  schemaCounts: Record<string, number>;
  /** 命中总数（含只计数没输出的） */
  findingCount: number;
  recordsWithFindings: number;
  byCategory: Record<FindingCategory, number>;
  /** 按命中数从多到少 */
  bySubtype: SubtypeCount[];
  /** 单条记录某一类命中超过 RECORD_CATEGORY_MAX 条，超出部分只计数没有输出的条数 */
  cappedFindings: number;
  /** 自定义正则超时次数（单条记录、单条正则算一次） */
  regexTimeouts: number;
  /** 超时 3 次后停用的自定义正则 */
  disabledRules: DisabledRule[];
  /** 超过 10 万字、自定义正则只检查了前 10 万字的字段数 */
  regexTruncatedFields: number;
  /** 超过 500 条上限、没有参与匹配的自定义正则数 */
  regexRulesIgnored: number;
}

export interface ScannerOptions {
  /** 国标关键词（term + 条目编码） */
  keywords?: readonly KeywordEntry[];
  /** 条目编码 → 名称 */
  codeLabels?: Readonly<Record<string, string>>;
  customRules?: readonly CustomRule[];
  /** 是否检测敏感信息，默认是 */
  sensitive?: boolean;
  /** 关键词最短长度，默认 2（与国标评估的关键词检查一致） */
  keywordMinLength?: number;
  /** 自定义正则单条记录的超时（毫秒），测试用 */
  regexTimeoutMs?: number;
}

export type ScanRecord = Extract<ParsedItem, { kind: 'record' }>;

export interface ScanHooks {
  /** 有违规命中的记录（裁判复核用） */
  onViolationRecord?: (record: ScanRecord, findings: CorpusFindingOut[]) => void;
}

export interface ScanSession {
  push(chunk: string): CorpusFindingOut[];
  end(): CorpusFindingOut[];
  /** 与 push 结果相同，处理中每隔 YIELD_MS 让出一次事件循环 */
  pushAsync(chunk: string): Promise<CorpusFindingOut[]>;
  endAsync(): Promise<CorpusFindingOut[]>;
  stats(): ScanStats;
}

function context(text: string, start: number, end: number) {
  return {
    matchText: text.slice(start, Math.min(end, start + MATCH_TEXT_MAX)),
    contextBefore: text.slice(Math.max(0, start - CONTEXT_CHARS), start),
    contextAfter: text.slice(end, end + CONTEXT_CHARS),
  };
}

function drain<T>(g: Generator<void, T, void>): T {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

export function createScanSession(
  parserOpts: ParserOptions,
  scannerOpts: ScannerOptions = {},
  hooks: ScanHooks = {},
): ScanSession {
  const parser = createCorpusParser(parserOpts);
  const ac = buildKeywordAutomaton(scannerOpts.keywords ?? [], {
    minLength: scannerOpts.keywordMinLength ?? 2,
  });
  const custom = compileCustomRules(scannerOpts.customRules ?? [], {
    timeoutMs: scannerOpts.regexTimeoutMs,
  });
  const withSensitive = scannerOpts.sensitive !== false;
  const labels = scannerOpts.codeLabels ?? {};

  let totalRecords = 0;
  let invalidRecords = 0;
  const invalidSamples: { line: number; reason: string }[] = [];
  const schemaCounts: Record<string, number> = {};
  let findingCount = 0;
  let recordsWithFindings = 0;
  let cappedFindings = 0;
  const byCategory: Record<FindingCategory, number> = { violation: 0, sensitive: 0, custom: 0 };
  const bySubtype = new Map<string, SubtypeCount>();

  const scanRecord = (rec: ScanRecord, customHits: CustomHit[]): CorpusFindingOut[] => {
    const out: CorpusFindingOut[] = [];
    const perCategory: Record<FindingCategory, number> = { violation: 0, sensitive: 0, custom: 0 };
    let any = false;
    /** 计数；本类没超过单条上限才生成命中对象（超出的不切上下文，省时省内存） */
    const emit = (
      category: FindingCategory,
      subtype: string,
      label: string | null,
      build: () => CorpusFindingOut,
    ) => {
      any = true;
      findingCount += 1;
      byCategory[category] += 1;
      const key = `${category}\u0000${subtype}`;
      const c = bySubtype.get(key);
      if (c) c.count += 1;
      else bySubtype.set(key, { category, subtype, label, count: 1 });
      if (perCategory[category] >= RECORD_CATEGORY_MAX) {
        cappedFindings += 1;
        return;
      }
      perCategory[category] += 1;
      out.push(build());
    };
    const base = { recordIndex: rec.index, line: rec.line };
    // 违规关键词：同一记录同一个词只记一次（同一个词登记在几个条目下就记几条）
    if (ac.size > 0) {
      const seen = new Set<number>();
      for (const f of rec.fields) {
        for (const h of ac.search(f.text, seen)) {
          for (const code of h.codes) {
            const label = labels[code] ?? null;
            emit('violation', code, label, () => ({
              ...base,
              fieldPath: f.path,
              category: 'violation',
              subtype: code,
              subtypeLabel: label,
              ruleId: null,
              severity: VIOLATION_SEVERITY,
              ...context(f.text, h.start, h.end),
            }));
          }
        }
      }
    }
    if (withSensitive) {
      for (const f of rec.fields) {
        for (const h of findSensitive(f.text)) {
          const label = SENSITIVE_LABELS[h.type] ?? h.label;
          emit('sensitive', h.type, label, () => ({
            ...base,
            fieldPath: f.path,
            category: 'sensitive',
            subtype: h.type,
            subtypeLabel: label,
            ruleId: null,
            severity: h.severity,
            ...context(f.text, h.start, h.end),
          }));
        }
      }
    }
    for (const h of customHits) {
      const f = rec.fields[h.fieldIndex]!;
      emit('custom', h.category, h.category, () => ({
        ...base,
        fieldPath: f.path,
        category: 'custom',
        subtype: h.category,
        subtypeLabel: h.category,
        ruleId: h.ruleId,
        severity: h.severity,
        ...context(f.text, h.start, h.end),
      }));
    }
    if (any) recordsWithFindings += 1;
    return out;
  };

  function* handle(items: ParsedItem[]): Generator<void, CorpusFindingOut[], void> {
    const all: CorpusFindingOut[] = [];
    const records = items.filter((x): x is ScanRecord => x.kind === 'record');
    const customHits =
      custom.size > 0 && records.length > 0
        ? yield* custom.scanBatch(records.map((r) => r.fields.map((f) => f.text)))
        : null;
    let r = 0;
    for (const item of items) {
      totalRecords += 1;
      if (item.kind === 'invalid') {
        invalidRecords += 1;
        if (invalidSamples.length < INVALID_SAMPLE_MAX)
          invalidSamples.push({ line: item.line, reason: item.reason });
        continue;
      }
      schemaCounts[item.schema] = (schemaCounts[item.schema] ?? 0) + 1;
      const found = scanRecord(item, customHits ? customHits[r]! : []);
      r += 1;
      if (found.length > 0 && hooks.onViolationRecord) {
        const v = found.filter((f) => f.category === 'violation');
        if (v.length > 0) hooks.onViolationRecord(item, v);
      }
      // 逐个放：一条记录可能有几千条命中，展开参数会撑爆调用栈
      for (const f of found) all.push(f);
      yield;
    }
    return all;
  }

  let lastYield = 0;
  async function drive(g: Generator<void, CorpusFindingOut[], void>): Promise<CorpusFindingOut[]> {
    if (lastYield === 0) lastYield = performance.now();
    for (;;) {
      const r = g.next();
      if (r.done) return r.value;
      if (performance.now() - lastYield >= YIELD_MS) {
        await nextTick();
        lastYield = performance.now();
      }
    }
  }

  return {
    push: (chunk) => drain(handle(parser.push(chunk))),
    end: () => drain(handle(parser.end())),
    pushAsync: (chunk) => drive(handle(parser.push(chunk))),
    endAsync: () => drive(handle(parser.end())),
    stats: () => ({
      container: parser.container(),
      detectedFormat: parser.detectedFormat(),
      totalRecords,
      invalidRecords,
      invalidSamples: invalidSamples.slice(),
      schemaCounts: { ...schemaCounts },
      findingCount,
      recordsWithFindings,
      byCategory: { ...byCategory },
      bySubtype: [...bySubtype.values()]
        .map((c) => ({ ...c }))
        .sort(
          (a, b) =>
            b.count - a.count ||
            a.category.localeCompare(b.category) ||
            a.subtype.localeCompare(b.subtype),
        ),
      cappedFindings,
      regexTimeouts: custom.timeouts(),
      disabledRules: custom.disabledRules(),
      regexTruncatedFields: custom.truncatedFields(),
      regexRulesIgnored: custom.ignoredRegexRules,
    }),
  };
}

/** 一次性扫描整段文本（测试和小文件用）。 */
export function scanCorpusText(
  text: string,
  opts: ParserOptions & ScannerOptions,
): { findings: CorpusFindingOut[]; stats: ScanStats } {
  const session = createScanSession(opts, opts);
  const findings = [...session.push(text), ...session.end()];
  return { findings, stats: session.stats() };
}
