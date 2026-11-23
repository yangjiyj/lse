import type { RagFormState } from './rag-form';

export type RagPayloadResult =
  | {
      ok: true;
      isRag: boolean;
      /** undefined：不提交（保留已保存配置）。 */
      ragOptions?: Record<string, unknown> | null;
      /** undefined：不修改；null：清除；字符串：设置新凭据。 */
      ragRestrictedUploadSecret?: string | null;
    }
  | { ok: false; error: string };

class PayloadError extends Error {}

function parseObject(text: string, label: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new PayloadError(`${label}需为 JSON 对象`);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new PayloadError(`${label}需为 JSON 对象`);
  return v as Record<string, unknown>;
}

function parseNum(text: string, label: string, min: number, max: number, int = true) {
  if (!text.trim()) return undefined;
  const n = Number(text);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) {
    throw new PayloadError(`${label}需为 ${min}–${max} 之间的${int ? '整数' : '数值'}`);
  }
  return n;
}

/**
 * 把「空值」按提交方式处理：
 * - 新建（patch=false）：空值直接省略；
 * - 编辑（patch=true）：空值提交 null，由后端合并时清除该项；其余键逐项覆盖，未出现在表单的键保持不变。
 */
function finalize(entries: Record<string, unknown>, patch: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entries)) {
    const empty = v === undefined || v === '';
    if (empty) {
      if (patch) out[k] = null;
    } else {
      out[k] = typeof v === 'string' ? v.trim() : v;
    }
  }
  return out;
}

function buildOptions(f: RagFormState, patch: boolean): Record<string, unknown> {
  const t = (s: string) => s.trim();
  const group = (enabled: boolean, entries: Record<string, unknown>) =>
    enabled ? finalize(entries, patch) : patch ? null : undefined;

  const knowledgeUpload = group(Boolean(t(f.ragUploadUrl)), {
    url: t(f.ragUploadUrl),
    method: f.ragUploadMethod,
    format: f.ragUploadFormat,
    bodyTemplate:
      f.ragUploadFormat === 'json' ? parseObject(f.ragUploadTemplate, '知识库上传请求体模板') : undefined,
    multipartFileField: f.ragUploadFormat === 'multipart' ? t(f.ragUploadFileField) : undefined,
    multipartFields:
      f.ragUploadFormat === 'multipart' ? parseObject(f.ragUploadFields, 'multipart 附加字段') : undefined,
    documentIdPath: t(f.ragUploadDocIdPath),
    restrictedKnowledgeBaseId: t(f.ragRestrictedKbId),
    // 旧字段已迁移到顶层 testKnowledgeBaseId，编辑时顺带清理。
    testKnowledgeBaseId: undefined,
  });
  const knowledgeDelete = group(Boolean(t(f.ragDeleteUrl)), {
    url: t(f.ragDeleteUrl),
    method: f.ragDeleteMethod,
    bodyTemplate: parseObject(f.ragDeleteTemplate, '删除接口请求体模板'),
  });
  const hasRetrieval = Boolean(t(f.ragRetrievalUrl));
  if (hasRetrieval && !t(f.ragRetrievalResultsPath)) {
    throw new PayloadError('配置检索接口时需填写结果数组 JSON 路径');
  }
  const retrieval = group(hasRetrieval, {
    url: t(f.ragRetrievalUrl),
    method: f.ragRetrievalMethod,
    bodyTemplate: parseObject(f.ragRetrievalTemplate, '检索接口请求体模板'),
    resultsPath: t(f.ragRetrievalResultsPath),
    textField: t(f.ragRetrievalTextField),
    idField: t(f.ragRetrievalIdField),
    topK: parseNum(f.ragRetrievalTopK, '检索 Top-K', 1, 50),
  });

  const top = finalize(
    {
      defaultAlignmentMode: f.ragMode,
      testKnowledgeBaseId: t(f.ragTestKbId),
      contextPath: t(f.ragContextPath),
      contextTextField: t(f.ragContextTextField),
      contextIdField: t(f.ragContextIdField),
      citationPath: t(f.ragCitationPath),
      citationTextField: t(f.ragCitationTextField),
      citationIdField: t(f.ragCitationIdField),
      restrictedUploadAuthHeader: t(f.ragRestrictedAuthHeader),
      indexWaitTimeoutSec: parseNum(f.ragIndexTimeout, '索引等待超时', 0, 3600),
      indexPollIntervalSec: parseNum(f.ragIndexPoll, '索引探测间隔', 1, 300),
      indexReadyThreshold: parseNum(f.ragIndexThreshold, '索引就绪比例', 0, 1, false),
    },
    patch,
  );
  if (knowledgeUpload !== undefined) top.knowledgeUpload = knowledgeUpload;
  if (knowledgeDelete !== undefined) top.knowledgeDelete = knowledgeDelete;
  if (retrieval !== undefined) top.retrieval = retrieval;
  return top;
}

/**
 * 由表单构造 RAG 相关提交字段。
 * - 非智能体应用 API 类或未勾选：isRag=false，且不提交 ragOptions（保留已保存配置，重新勾选可恢复）。
 * - 编辑：按合并补丁提交，清空的输入传 null；新建：只提交非空项。
 */
export function buildRagPayload(
  form: RagFormState,
  opts: { eligible: boolean; patch: boolean },
): RagPayloadResult {
  const secret = form.ragRestrictedSecret.trim();
  const ragRestrictedUploadSecret = secret
    ? secret
    : form.ragClearRestrictedSecret && opts.patch
      ? null
      : undefined;
  if (!opts.eligible || !form.isRag) {
    return { ok: true, isRag: false };
  }
  try {
    return {
      ok: true,
      isRag: true,
      ragOptions: buildOptions(form, opts.patch),
      ...(ragRestrictedUploadSecret !== undefined ? { ragRestrictedUploadSecret } : {}),
    };
  } catch (e) {
    if (e instanceof PayloadError) return { ok: false, error: e.message };
    throw e;
  }
}
