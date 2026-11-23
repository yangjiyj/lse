import { Link } from 'react-router-dom';
import { RagGroup, RagSelect, RagText, type RagCtx } from './rag-field-kit';
import { UploadGroups } from './rag-upload-groups';
import { RAG_MODE_OPTIONS, isRagEligibleTargetType, type RagFormState } from './rag-form';

export {
  EMPTY_RAG_FORM,
  RAG_MODE_OPTIONS,
  isRagEligibleTargetType,
  ragFormFields,
  type RagAlignmentMode,
  type RagFormState,
} from './rag-form';
export { buildRagPayload, type RagPayloadResult } from './rag-payload';

export { DEFAULT_UPLOAD_TEMPLATE } from './rag-upload-groups';

interface Props<T extends RagFormState> {
  form: T;
  setForm: (next: T) => void;
  /** 表单当前的有效评估对象类型（如 AGENT_API / PUBLIC_AGENT / MODEL）。 */
  targetType: string;
  /** RAG 专项评估页弹窗：固定为已声明，不显示取消勾选与跳转说明。 */
  lockDeclared?: boolean;
}

export function RagTargetFields<T extends RagFormState>({
  form,
  setForm,
  targetType,
  lockDeclared,
}: Props<T>) {
  const eligible = isRagEligibleTargetType(targetType);
  const ctx: RagCtx<T> = { form, setForm };
  return (
    <div className="flex flex-col gap-3 border-t border-slate-200 pt-3 sm:col-span-2">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          disabled={!eligible || lockDeclared}
          checked={eligible && form.isRag}
          onChange={(e) => setForm({ ...form, isRag: e.target.checked })}
        />
        声明为 RAG 应用（开放 RAG 专项评估）
      </label>
      {!eligible && (
        <p className="text-xs text-slate-500">
          仅“智能体应用 API（自定义 HTTP）”类评估对象可声明为 RAG 应用：RAG
          专项评估需要从原始响应读取检索上下文与引用来源。如需评估，请将接入方式切换为“智能体应用
          API”，也可在 <Link to="/inspect/rag" className="text-primary">RAG 专项评估</Link>{' '}
          页直接新建 RAG 评估对象。
        </p>
      )}
      {eligible && form.isRag && <RagGroups ctx={ctx} />}
      {eligible && form.isRag && !lockDeclared && (
        <p className="text-xs text-slate-500">
          配置保存后可在 <Link to="/inspect/rag" className="text-primary">RAG 专项评估</Link>{' '}
          中选择本对象；评估模型在{' '}
          <Link to="/settings#independent-judge-model" className="text-primary">
            系统设置 · 独立评估模型
          </Link>{' '}
          配置。
        </p>
      )}
    </div>
  );
}

function RagGroups<T extends RagFormState>({ ctx }: { ctx: RagCtx<T> }) {
  const f = ctx.form;
  return (
    <div className="flex flex-col gap-3">
      <RagGroup title="基本" desc="知识对齐模式决定评估如何保证被测知识库与测试文档一致。">
        <RagSelect
          ctx={ctx}
          k="ragMode"
          label="默认知识对齐模式"
          options={[{ value: '', label: '不预选（新建测试集时选择）' }, ...RAG_MODE_OPTIONS]}
          hint={RAG_MODE_OPTIONS.find((m) => m.value === f.ragMode)?.hint}
        />
        <RagText
          ctx={ctx}
          k="ragTestKbId"
          label="测试知识库标识"
          placeholder="kb-lse-test"
          hint="提问、上传、检索时替换模板中的 {{knowledge_base_id}}"
        />
      </RagGroup>
      <RagGroup
        title="检索上下文与引用"
        desc="从被测接口原始响应中读取。未配置上下文路径时忠实度记“未评估”；未配置引用路径时引用准确性记“未评估”。"
      >
        <RagText ctx={ctx} k="ragContextPath" label="检索上下文 JSON 路径" placeholder="data.contexts" />
        <RagText ctx={ctx} k="ragContextTextField" label="上下文原文字段名" placeholder="content" />
        <RagText
          ctx={ctx}
          k="ragContextIdField"
          label="上下文 ID 字段名"
          placeholder="chunk_id"
          hint="用于检索命中判定，可留空（按原文匹配）"
        />
        <RagText ctx={ctx} k="ragCitationPath" label="引用来源 JSON 路径" placeholder="data.citations" />
        <RagText ctx={ctx} k="ragCitationTextField" label="引用原文字段名" placeholder="content" />
        <RagText
          ctx={ctx}
          k="ragCitationIdField"
          label="引用 ID 字段名"
          placeholder="doc_id"
          hint="按 ID、文件名或内容哈希映射到测试文档切块"
        />
      </RagGroup>
      <UploadGroups ctx={ctx} />
    </div>
  );
}
