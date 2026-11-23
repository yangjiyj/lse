import { z } from 'zod';

/**
 * 评估对象的 RAG 声明配置（ModelTarget.ragOptions）。所有字段可选，旧数据按原结构兼容读取。
 * - defaultAlignmentMode：知识对齐模式默认值（新建测试集时预选）。
 * - testKnowledgeBaseId：平台专用测试知识库标识，提问/上传/检索时替换 {{knowledge_base_id}}。
 *   旧数据存于 knowledgeUpload.testKnowledgeBaseId，读取时自动迁移到顶层。
 * - contextPath / contextTextField / contextIdField：被测接口响应中「本次检索上下文」的位置；
 *   配置后忠实度以被测系统实际检索到的上下文为依据，未配置或取不到时忠实度记「未评估」。
 * - citationPath / citationTextField / citationIdField：响应中「引用来源」的位置与字段。
 * - knowledgeUpload：上传文档到知识库的接口（JSON 或 multipart，method 可配）。
 * - knowledgeDelete：删除已上传文档的接口，运行结束后自动清理。
 * - retrieval：检索接口（query → 文档片段列表），模式 C「检索接口直评」使用。
 * - restrictedUploadAuthHeader：受限库上传凭据所用请求头名；凭据值加密存于独立列，不在此处。
 * - indexWaitTimeoutSec / indexPollIntervalSec / indexReadyThreshold：索引就绪探测参数。
 */
const UNSAFE_SEGMENTS = /(^|[.[\]])(__proto__|prototype|constructor)([.[\]]|$)/;

export const RAG_ALIGNMENT_MODES = ['KB_EXISTING', 'TEST_PACKAGE', 'RETRIEVAL_API'] as const;
export type RagAlignmentMode = (typeof RAG_ALIGNMENT_MODES)[number];

const jsonPath = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((v) => !UNSAFE_SEGMENTS.test(v), { message: 'JSON 路径不得包含原型链字段' });

const fieldName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((v) => !UNSAFE_SEGMENTS.test(v), { message: '字段名非法' });

const headerName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9-]+$/, '请求头名只能包含字母、数字与连字符');

const httpUrl = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((v) => /^https?:\/\//i.test(v), { message: '接口地址仅支持 http/https' });

const kbId = z.string().trim().max(200);

export const knowledgeUploadSchema = z.object({
  url: httpUrl,
  method: z.enum(['POST', 'PUT']).default('POST'),
  /** json：请求体按 bodyTemplate 渲染；multipart：文件放在 multipartFileField，其他字段取 multipartFields。 */
  format: z.enum(['json', 'multipart']).default('json'),
  /** JSON 请求体模板，支持占位符 {{filename}}、{{content}}、{{content_base64}}、{{knowledge_base_id}}。 */
  bodyTemplate: z.record(z.unknown()).optional(),
  multipartFileField: fieldName.optional(),
  /** multipart 附加字段（值支持同样的占位符）。 */
  multipartFields: z.record(z.string().max(500)).optional(),
  /** 上传响应中被测系统文档 ID 的 JSON 路径；配置后删除接口可用 {{document_id}}。 */
  documentIdPath: jsonPath.optional(),
  /** 旧字段：历史数据把测试知识库标识放在这里，读取时迁移到顶层 testKnowledgeBaseId。 */
  testKnowledgeBaseId: kbId.optional(),
  /** 当前测试身份无权访问的受限知识库/租户标识；越权哨兵文档上传至此。 */
  restrictedKnowledgeBaseId: kbId.optional(),
});

export const knowledgeDeleteSchema = z.object({
  /** 支持占位符 {{document_id}}、{{filename}}、{{knowledge_base_id}}。 */
  url: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine((v) => /^https?:\/\//i.test(v), { message: '删除接口仅支持 http/https' }),
  method: z.enum(['DELETE', 'POST']).default('DELETE'),
  bodyTemplate: z.record(z.unknown()).optional(),
});

export const retrievalSchema = z.object({
  url: httpUrl,
  method: z.enum(['POST', 'GET']).default('POST'),
  /** 请求体模板，支持 {{query}}、{{top_k}}、{{knowledge_base_id}}；GET 时作为查询参数。 */
  bodyTemplate: z.record(z.unknown()).optional(),
  /** 响应中结果数组的 JSON 路径，如 data.results。 */
  resultsPath: jsonPath,
  textField: fieldName.optional(),
  idField: fieldName.optional(),
  topK: z.coerce.number().int().min(1).max(50).default(5),
});

export const ragOptionsSchema = z.object({
  defaultAlignmentMode: z.enum(RAG_ALIGNMENT_MODES).optional(),
  testKnowledgeBaseId: kbId.optional(),
  contextPath: jsonPath.optional(),
  contextTextField: fieldName.optional(),
  contextIdField: fieldName.optional(),
  citationPath: jsonPath.optional(),
  citationTextField: fieldName.optional(),
  citationIdField: fieldName.optional(),
  knowledgeUpload: knowledgeUploadSchema.optional(),
  knowledgeDelete: knowledgeDeleteSchema.optional(),
  retrieval: retrievalSchema.optional(),
  restrictedUploadAuthHeader: headerName.optional(),
  indexWaitTimeoutSec: z.coerce.number().int().min(0).max(3600).optional(),
  indexPollIntervalSec: z.coerce.number().int().min(1).max(300).optional(),
  indexReadyThreshold: z.coerce.number().min(0).max(1).optional(),
});

export type RagOptions = z.infer<typeof ragOptionsSchema>;
export type KnowledgeUploadConfig = z.infer<typeof knowledgeUploadSchema>;
export type KnowledgeDeleteConfig = z.infer<typeof knowledgeDeleteSchema>;
export type RetrievalConfig = z.infer<typeof retrievalSchema>;

export const RAG_INDEX_DEFAULTS = { timeoutSec: 120, pollSec: 5, threshold: 1 } as const;

/** 旧数据兼容：knowledgeUpload.testKnowledgeBaseId → 顶层 testKnowledgeBaseId（顶层优先）。 */
function normalize(opts: RagOptions): RagOptions {
  const legacy = opts.knowledgeUpload?.testKnowledgeBaseId;
  if (!opts.testKnowledgeBaseId && legacy) return { ...opts, testKnowledgeBaseId: legacy };
  return opts;
}

/** 解析并规范化 ragOptions；null/undefined 视为空配置，非法输入抛出 ZodError（路由层转为 400）。 */
export function parseRagOptions(value: unknown): RagOptions {
  if (value === null || value === undefined) return {};
  return normalize(ragOptionsSchema.parse(value));
}

/** 读取已落库的 ragOptions，不合法时按空配置处理（不因历史脏数据中断评估）。 */
export function readStoredRagOptions(value: unknown): RagOptions {
  const parsed = ragOptionsSchema.safeParse(value ?? {});
  return parsed.success ? normalize(parsed.data) : {};
}

export function testKnowledgeBaseId(opts: RagOptions): string {
  return opts.testKnowledgeBaseId ?? opts.knowledgeUpload?.testKnowledgeBaseId ?? '';
}

/** 声明为 RAG 应用只对「智能体应用 API（自定义 HTTP）」开放：需要读取原始响应里的检索上下文/引用。 */
export const RAG_ELIGIBLE_TARGET_TYPES = ['AGENT_API'] as const;
export const RAG_TARGET_TYPE_MESSAGE =
  '“声明为 RAG 应用”仅支持智能体应用 API（自定义 HTTP）类评估对象：需要从原始响应读取检索上下文与引用来源';

export function isRagEligibleType(t: string): boolean {
  return (RAG_ELIGIBLE_TARGET_TYPES as readonly string[]).includes(t);
}
