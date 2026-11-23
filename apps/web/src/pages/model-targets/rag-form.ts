import type { ModelTarget } from '@/lib/api';

/** 知识对齐模式（与后端 RAG_ALIGNMENT_MODES 一致）。 */
export type RagAlignmentMode = 'KB_EXISTING' | 'TEST_PACKAGE' | 'RETRIEVAL_API';

export const RAG_MODE_OPTIONS: { value: RagAlignmentMode; label: string; hint: string }[] = [
  {
    value: 'KB_EXISTING',
    label: '已有知识库',
    hint: '被测系统已导入与测试文档一致的知识，运行前需人工确认对齐',
  },
  {
    value: 'TEST_PACKAGE',
    label: '测试知识库包',
    hint: '平台生成测试包（zip + manifest），自动上传或人工导入后评估',
  },
  {
    value: 'RETRIEVAL_API',
    label: '检索接口直评',
    hint: '直接调用检索接口计算 Hit@k / MRR，不经过生成',
  },
];

/** 声明 RAG 只对「智能体应用 API（自定义 HTTP）」开放。 */
export function isRagEligibleTargetType(type: string | null | undefined): boolean {
  return type === 'AGENT_API';
}

/** 评估对象表单中与 RAG 声明相关的字段（ModelTargetsPage 的 FormState 继承本接口）。 */
export interface RagFormState {
  isRag: boolean;
  ragMode: RagAlignmentMode | '';
  ragTestKbId: string;
  ragContextPath: string;
  ragContextTextField: string;
  ragContextIdField: string;
  ragCitationPath: string;
  ragCitationTextField: string;
  ragCitationIdField: string;
  ragUploadUrl: string;
  ragUploadMethod: 'POST' | 'PUT';
  ragUploadFormat: 'json' | 'multipart';
  ragUploadTemplate: string;
  ragUploadFileField: string;
  ragUploadFields: string;
  ragUploadDocIdPath: string;
  ragRestrictedKbId: string;
  ragDeleteUrl: string;
  ragDeleteMethod: 'DELETE' | 'POST';
  ragDeleteTemplate: string;
  ragRetrievalUrl: string;
  ragRetrievalMethod: 'POST' | 'GET';
  ragRetrievalTemplate: string;
  ragRetrievalResultsPath: string;
  ragRetrievalTextField: string;
  ragRetrievalIdField: string;
  ragRetrievalTopK: string;
  ragRestrictedAuthHeader: string;
  /** 受限库上传凭据：只写，不回显；留空表示不修改。 */
  ragRestrictedSecret: string;
  ragClearRestrictedSecret: boolean;
  /** 只读展示：已保存对象是否已设置受限凭据。 */
  ragHasRestrictedSecret: boolean;
  ragIndexTimeout: string;
  ragIndexPoll: string;
  ragIndexThreshold: string;
}

export const EMPTY_RAG_FORM: RagFormState = {
  isRag: false,
  ragMode: '',
  ragTestKbId: '',
  ragContextPath: '',
  ragContextTextField: '',
  ragContextIdField: '',
  ragCitationPath: '',
  ragCitationTextField: '',
  ragCitationIdField: '',
  ragUploadUrl: '',
  ragUploadMethod: 'POST',
  ragUploadFormat: 'json',
  ragUploadTemplate: '',
  ragUploadFileField: '',
  ragUploadFields: '',
  ragUploadDocIdPath: '',
  ragRestrictedKbId: '',
  ragDeleteUrl: '',
  ragDeleteMethod: 'DELETE',
  ragDeleteTemplate: '',
  ragRetrievalUrl: '',
  ragRetrievalMethod: 'POST',
  ragRetrievalTemplate: '',
  ragRetrievalResultsPath: '',
  ragRetrievalTextField: '',
  ragRetrievalIdField: '',
  ragRetrievalTopK: '',
  ragRestrictedAuthHeader: '',
  ragRestrictedSecret: '',
  ragClearRestrictedSecret: false,
  ragHasRestrictedSecret: false,
  ragIndexTimeout: '',
  ragIndexPoll: '',
  ragIndexThreshold: '',
};

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function json(value: unknown): string {
  return value && typeof value === 'object' ? JSON.stringify(value, null, 2) : '';
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

/** 编辑已有对象时把 ragOptions 摊平为表单字段；兼容旧数据 knowledgeUpload.testKnowledgeBaseId。 */
export function ragFormFields(
  t: Pick<ModelTarget, 'isRag' | 'ragOptions' | 'hasRagRestrictedUploadSecret'>,
): RagFormState {
  const o = obj(t.ragOptions);
  const up = obj(o.knowledgeUpload);
  const del = obj(o.knowledgeDelete);
  const rt = obj(o.retrieval);
  return {
    ...EMPTY_RAG_FORM,
    isRag: Boolean(t.isRag),
    ragMode: pick(o.defaultAlignmentMode, ['KB_EXISTING', 'TEST_PACKAGE', 'RETRIEVAL_API'], '') as
      | RagAlignmentMode
      | '',
    ragTestKbId: str(o.testKnowledgeBaseId) || str(up.testKnowledgeBaseId),
    ragContextPath: str(o.contextPath),
    ragContextTextField: str(o.contextTextField),
    ragContextIdField: str(o.contextIdField),
    ragCitationPath: str(o.citationPath),
    ragCitationTextField: str(o.citationTextField),
    ragCitationIdField: str(o.citationIdField),
    ragUploadUrl: str(up.url),
    ragUploadMethod: pick(up.method, ['POST', 'PUT'], 'POST'),
    ragUploadFormat: pick(up.format, ['json', 'multipart'], 'json'),
    ragUploadTemplate: json(up.bodyTemplate),
    ragUploadFileField: str(up.multipartFileField),
    ragUploadFields: json(up.multipartFields),
    ragUploadDocIdPath: str(up.documentIdPath),
    ragRestrictedKbId: str(up.restrictedKnowledgeBaseId),
    ragDeleteUrl: str(del.url),
    ragDeleteMethod: pick(del.method, ['DELETE', 'POST'], 'DELETE'),
    ragDeleteTemplate: json(del.bodyTemplate),
    ragRetrievalUrl: str(rt.url),
    ragRetrievalMethod: pick(rt.method, ['POST', 'GET'], 'POST'),
    ragRetrievalTemplate: json(rt.bodyTemplate),
    ragRetrievalResultsPath: str(rt.resultsPath),
    ragRetrievalTextField: str(rt.textField),
    ragRetrievalIdField: str(rt.idField),
    ragRetrievalTopK: num(rt.topK),
    ragRestrictedAuthHeader: str(o.restrictedUploadAuthHeader),
    ragHasRestrictedSecret: Boolean(t.hasRagRestrictedUploadSecret),
    ragIndexTimeout: num(o.indexWaitTimeoutSec),
    ragIndexPoll: num(o.indexPollIntervalSec),
    ragIndexThreshold: num(o.indexReadyThreshold),
  };
}
