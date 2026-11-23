import type { ReactNode } from 'react';

/** 一条检索上下文/引用片段的结构化视图；无法识别时 raw 保留原值，按格式化 JSON 折叠展示。 */
export interface EvidenceEntry {
  source: string | null;
  score: number | null;
  text: string | null;
  raw: unknown;
}

const TEXT_KEYS = ['text', 'content', 'page_content', 'pageContent', 'snippet', 'chunk'];
const SOURCE_KEYS = [
  'filename',
  'file',
  'title',
  'source',
  'document',
  'doc',
  'docName',
  'document_name',
  'id',
  'doc_id',
  'documentId',
];
const SCORE_KEYS = ['score', 'similarity', 'relevance', 'distance'];

function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (o[k] != null && o[k] !== '') return o[k];
  return undefined;
}

export function toEvidence(v: unknown): EvidenceEntry {
  if (typeof v === 'string') return { source: null, score: null, text: v, raw: v };
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const t = pick(o, TEXT_KEYS);
    const s = pick(o, SOURCE_KEYS);
    const sc = pick(o, SCORE_KEYS);
    const text = typeof t === 'string' ? t : null;
    const source = typeof s === 'string' || typeof s === 'number' ? String(s) : null;
    const score = typeof sc === 'number' && Number.isFinite(sc) ? sc : null;
    if (text !== null || source !== null) return { source, score, text, raw: v };
  }
  return { source: null, score: null, text: null, raw: v };
}

function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}

/**
 * 检索上下文可能是片段数组，或模式 C 的 { answerContext, retrieval }（回答时上下文 + 检索接口结果）。
 * 返回分组后的片段；未知结构原样作为一个分组的单个“未识别”片段。
 */
export function contextGroups(
  v: unknown,
): Array<{ title: string | null; entries: EvidenceEntry[] }> {
  if (
    v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    ('answerContext' in v || 'retrieval' in v)
  ) {
    const o = v as { answerContext?: unknown; retrieval?: unknown };
    return [
      { title: '回答时的检索上下文', entries: asList(o.answerContext).map(toEvidence) },
      { title: '检索接口返回', entries: asList(o.retrieval).map(toEvidence) },
    ];
  }
  return [{ title: null, entries: asList(v).map(toEvidence) }];
}

export function citationEntries(v: unknown): EvidenceEntry[] {
  return asList(v).map(toEvidence);
}

function RawJson({ value }: { value: unknown }) {
  let s: string;
  try {
    s = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    s = String(value);
  }
  return (
    <details>
      <summary className="cursor-pointer text-slate-500">未识别的结构，展开查看原始 JSON</summary>
      <pre className="mt-1 whitespace-pre-wrap break-all text-slate-600">{s}</pre>
    </details>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span>
      <span className="text-slate-500">{label}：</span>
      {children}
    </span>
  );
}

/** 单个片段块：来源/文档名、分数、正文。 */
export function EvidenceBlock({ e, index }: { e: EvidenceEntry; index: number }) {
  const known = e.text !== null || e.source !== null;
  return (
    <li
      className="space-y-1 rounded-lg border border-slate-100 p-2 text-xs"
      aria-label={`片段 ${index + 1}`}
    >
      <div className="flex flex-wrap gap-x-4 text-slate-500">
        <span className="text-slate-500">#{index + 1}</span>
        {known && <Meta label="来源">{e.source ?? '未标注'}</Meta>}
        {e.score !== null && <Meta label="分数">{e.score.toFixed(3)}</Meta>}
      </div>
      {known ? (
        <p className="whitespace-pre-wrap break-all text-slate-700">{e.text ?? '（无正文）'}</p>
      ) : (
        <RawJson value={e.raw} />
      )}
    </li>
  );
}

/** 引用列表项：文档标识 + 引用片段（有则显示）。 */
export function CitationItem({ e, index }: { e: EvidenceEntry; index: number }) {
  if (e.text === null && e.source === null) {
    return (
      <li className="text-xs">
        <RawJson value={e.raw} />
      </li>
    );
  }
  return (
    <li className="text-xs text-slate-600" aria-label={`引用 ${index + 1}`}>
      <span className="font-medium text-slate-700">{e.source ?? '未标注来源'}</span>
      {e.score !== null && <span className="ml-2 text-slate-500">分数 {e.score.toFixed(3)}</span>}
      {e.text && <p className="mt-0.5 whitespace-pre-wrap break-all text-slate-500">{e.text}</p>}
    </li>
  );
}
