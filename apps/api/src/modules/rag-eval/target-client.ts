import type { ChatMessage, LlmCallResult } from '@lse/shared';
import { readJsonPath } from '@lse/shared';
import {
  buildAgentApiRequest,
  invokeEvaluationTarget,
  type EvaluationTargetConfig,
  type InvokeEvaluationTargetOptions,
} from '../eval-targets/invoker.js';
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  TargetEgressError,
  fetchTarget,
  readResponseBodyLimited,
  resolveServerTargetEgressContext,
} from '../../lib/target-egress-policy.js';
import {
  testKnowledgeBaseId,
  type KnowledgeDeleteConfig,
  type KnowledgeUploadConfig,
  type RagOptions,
  type RetrievalConfig,
} from './options.js';

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 递归替换模板字符串中的占位符（跳过原型链键）。 */
export function renderPlaceholders(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{{${k}}}`, v);
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => renderPlaceholders(item, vars));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(k)) continue;
      out[k] = renderPlaceholders(v, vars);
    }
    return out;
  }
  return value;
}

/** URL 中的占位符需 URL 编码，防止标识里的 / ? # 改写路径。 */
function renderUrl(url: string, vars: Record<string, string>): string {
  let out = url;
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{{${k}}}`, encodeURIComponent(v));
  return out;
}

/**
 * 调用被测 RAG 应用：复用评估对象调用适配器（invokeEvaluationTarget，含出站 SSRF 校验）。
 * 请求模板中的 {{knowledge_base_id}} 替换为测试知识库标识（独立配置，不依赖上传接口）。
 */
export async function askRagTarget(
  target: EvaluationTargetConfig,
  rag: RagOptions,
  question: string,
  options: InvokeEvaluationTargetOptions = {},
): Promise<LlmCallResult> {
  const kb = testKnowledgeBaseId(rag);
  const accessConfig = isRecord(target.accessConfig)
    ? (renderPlaceholders(target.accessConfig, { knowledge_base_id: kb, question }) as Record<
        string,
        unknown
      >)
    : target.accessConfig;
  const messages: ChatMessage[] = [{ role: 'user', content: question }];
  return invokeEvaluationTarget({ ...target, accessConfig }, messages, options);
}

export interface ContextEntry {
  text: string | null;
  id: string | null;
}

/** 按 JSON 路径从原始响应取出片段列表：支持数组（字符串/对象元素）与单个字符串。 */
export function readEntries(
  raw: unknown,
  path: string | undefined,
  textField = 'content',
  idField = 'id',
): ContextEntry[] | null {
  if (!path) return null;
  const wildcard = path.indexOf('[*]');
  let value: unknown;
  if (wildcard >= 0) {
    const list = readJsonPath(raw, path.slice(0, wildcard));
    const suffix = path.slice(wildcard + 3).replace(/^\./, '');
    value = Array.isArray(list) ? list.slice(0, 50).map(entry => suffix ? readJsonPath(entry, suffix) : entry) : undefined;
    if (Array.isArray(value) && value.length > 0 && value.every(entry => entry === undefined)) value = undefined;
  } else value = readJsonPath(raw, path);
  if (typeof value === 'string') return value.trim() ? [{ text: value, id: null }] : [];
  if (!Array.isArray(value)) return null;
  return value.slice(0, 50).map((entry) => {
    if (typeof entry === 'string') return { text: entry, id: null };
    if (isRecord(entry)) {
      const text = UNSAFE_KEYS.has(textField) ? undefined : entry[textField];
      const id = UNSAFE_KEYS.has(idField) ? undefined : entry[idField];
      return {
        text: typeof text === 'string' ? text : null,
        id: typeof id === 'string' || typeof id === 'number' ? String(id) : null,
      };
    }
    return { text: null, id: null };
  });
}

/** 被测系统本次检索上下文；未配置 contextPath 或响应中没有该字段时返回 null（忠实度记“未评估”）。 */
export function extractContext(raw: unknown, rag: RagOptions): ContextEntry[] | null {
  return readEntries(raw, rag.contextPath, rag.contextTextField, rag.contextIdField);
}

export interface UploadOutcome {
  ok: boolean;
  httpStatus: number | null;
  error: string | null;
  /** 被测系统返回的文档 ID（配置 documentIdPath 时）。 */
  documentId?: string | null;
}

const DEFAULT_UPLOAD_BODY = {
  knowledge_base_id: '{{knowledge_base_id}}',
  filename: '{{filename}}',
  content: '{{content}}',
};

/** 上传鉴权：默认沿用被测身份；越权哨兵必须传入单独的受限库上传凭据，此时不带被测身份的任何头。 */
export type UploadAuth =
  | { kind: 'target' }
  | { kind: 'restricted'; headerName: string; value: string };

function uploadHeaders(target: EvaluationTargetConfig, auth: UploadAuth): Record<string, string> {
  if (auth.kind === 'restricted') {
    const v = auth.headerName.toLowerCase() === 'authorization' && !/\s/.test(auth.value)
      ? `Bearer ${auth.value}`
      : auth.value;
    return { [auth.headerName]: v };
  }
  const { headers } = buildAgentApiRequest(target, '');
  const out = { ...headers };
  delete out['content-type'];
  return out;
}

function errOutcome(err: unknown, label: string): UploadOutcome {
  if (err instanceof TargetEgressError) return { ok: false, httpStatus: null, error: err.message };
  const e = err as Error;
  return {
    ok: false,
    httpStatus: null,
    error: e.name === 'AbortError' ? `${label}请求超时` : `${label}失败：${e.message}`,
  };
}

/**
 * 把测试文档上传到被测系统的知识库：地址来自 ragOptions.knowledgeUpload，支持 JSON 与 multipart，
 * 出站经 fetchTarget 做允许清单/内网/重定向校验。
 */
export async function uploadKnowledgeDocument(
  target: EvaluationTargetConfig,
  upload: KnowledgeUploadConfig,
  doc: { filename: string; content: string; knowledgeBaseId: string },
  opts: { timeoutMs?: number; signal?: AbortSignal; auth?: UploadAuth } = {},
): Promise<UploadOutcome> {
  const vars = {
    filename: doc.filename,
    content: doc.content,
    content_base64: Buffer.from(doc.content, 'utf8').toString('base64'),
    knowledge_base_id: doc.knowledgeBaseId,
  };
  const headers = uploadHeaders(target, opts.auth ?? { kind: 'target' });
  let body: string | FormData;
  if (upload.format === 'multipart') {
    const form = new FormData();
    for (const [k, v] of Object.entries(upload.multipartFields ?? {})) {
      if (UNSAFE_KEYS.has(k)) continue;
      form.append(k, renderPlaceholders(v, vars) as string);
    }
    form.append(
      upload.multipartFileField ?? 'file',
      new Blob([doc.content], { type: 'text/markdown' }),
      doc.filename,
    );
    body = form;
  } else {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(renderPlaceholders(upload.bodyTemplate ?? DEFAULT_UPLOAD_BODY, vars));
  }
  try {
    const res = await fetchTarget(
      renderUrl(upload.url, { knowledge_base_id: doc.knowledgeBaseId }),
      { method: upload.method, headers, body, ...(opts.signal ? { signal: opts.signal } : {}) },
      { context: resolveServerTargetEgressContext(), timeoutMs: opts.timeoutMs ?? 60_000 },
    );
    const text = await readResponseBodyLimited(res, DEFAULT_MAX_RESPONSE_BYTES);
    if (!res.ok)
      return { ok: false, httpStatus: res.status, error: `知识库上传接口返回 HTTP ${res.status}` };
    let documentId: string | null = null;
    if (upload.documentIdPath) {
      try {
        const v = readJsonPath(JSON.parse(text), upload.documentIdPath);
        if (typeof v === 'string' || typeof v === 'number') documentId = String(v);
      } catch {
        documentId = null;
      }
    }
    return { ok: true, httpStatus: res.status, error: null, documentId };
  } catch (err) {
    return errOutcome(err, '知识库上传');
  }
}

/** 调用删除接口清理已上传文档。 */
export async function deleteKnowledgeDocument(
  target: EvaluationTargetConfig,
  cfg: KnowledgeDeleteConfig,
  doc: { documentId: string | null; filename: string; knowledgeBaseId: string },
  opts: { timeoutMs?: number; auth?: UploadAuth } = {},
): Promise<UploadOutcome> {
  const vars = {
    document_id: doc.documentId ?? '',
    filename: doc.filename,
    knowledge_base_id: doc.knowledgeBaseId,
  };
  const headers = uploadHeaders(target, opts.auth ?? { kind: 'target' });
  const init: RequestInit = { method: cfg.method, headers };
  if (cfg.bodyTemplate) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(renderPlaceholders(cfg.bodyTemplate, vars));
  }
  try {
    const res = await fetchTarget(renderUrl(cfg.url, vars), init, {
      context: resolveServerTargetEgressContext(),
      timeoutMs: opts.timeoutMs ?? 30_000,
    });
    await readResponseBodyLimited(res, DEFAULT_MAX_RESPONSE_BYTES);
    if (!res.ok)
      return { ok: false, httpStatus: res.status, error: `删除接口返回 HTTP ${res.status}` };
    return { ok: true, httpStatus: res.status, error: null };
  } catch (err) {
    return errOutcome(err, '删除文档');
  }
}

export type RetrievalOutcome =
  | { ok: true; entries: ContextEntry[]; latencyMs: number }
  | { ok: false; error: string; latencyMs: number };

/** 调用被测系统检索接口（模式 C）：query → 片段列表，鉴权沿用被测身份。 */
export async function retrieveFromTarget(
  target: EvaluationTargetConfig,
  rag: RagOptions,
  cfg: RetrievalConfig,
  query: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RetrievalOutcome> {
  const started = Date.now();
  const vars = {
    query,
    top_k: String(cfg.topK),
    knowledge_base_id: testKnowledgeBaseId(rag),
  };
  const headers = uploadHeaders(target, { kind: 'target' });
  const rendered = renderPlaceholders(cfg.bodyTemplate ?? { query: '{{query}}', top_k: '{{top_k}}' }, vars);
  let url = renderUrl(cfg.url, vars);
  const init: RequestInit = { method: cfg.method, headers };
  if (cfg.method === 'GET') {
    const u = new URL(url);
    if (isRecord(rendered))
      for (const [k, v] of Object.entries(rendered)) u.searchParams.set(k, String(v));
    url = u.toString();
  } else {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(rendered);
  }
  if (opts.signal) init.signal = opts.signal;
  try {
    const res = await fetchTarget(url, init, {
      context: resolveServerTargetEgressContext(),
      timeoutMs: opts.timeoutMs ?? 30_000,
    });
    const text = await readResponseBodyLimited(res, DEFAULT_MAX_RESPONSE_BYTES);
    if (!res.ok)
      return { ok: false, error: `检索接口返回 HTTP ${res.status}`, latencyMs: Date.now() - started };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: '检索接口未返回 JSON', latencyMs: Date.now() - started };
    }
    const entries = readEntries(json, cfg.resultsPath, cfg.textField, cfg.idField);
    if (entries === null)
      return {
        ok: false,
        error: `检索接口响应中没有结果数组（${cfg.resultsPath}）`,
        latencyMs: Date.now() - started,
      };
    return { ok: true, entries: entries.slice(0, cfg.topK), latencyMs: Date.now() - started };
  } catch (err) {
    const o = errOutcome(err, '检索接口');
    return { ok: false, error: o.error ?? '检索接口调用失败', latencyMs: Date.now() - started };
  }
}
