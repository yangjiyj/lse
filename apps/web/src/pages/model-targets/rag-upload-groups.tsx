import { RagGroup, RagJson, RagSelect, RagText, type RagCtx } from './rag-field-kit';
import type { RagFormState } from './rag-form';

export const DEFAULT_UPLOAD_TEMPLATE = JSON.stringify(
  { knowledge_base_id: '{{knowledge_base_id}}', filename: '{{filename}}', content: '{{content}}' },
  null,
  2,
);
const DEFAULT_RETRIEVAL_TEMPLATE = JSON.stringify(
  { query: '{{query}}', top_k: '{{top_k}}', knowledge_base_id: '{{knowledge_base_id}}' },
  null,
  2,
);

/** 知识库上传 / 删除 / 检索 / 受限凭据 / 索引等待 分组。 */
export function UploadGroups<T extends RagFormState>({ ctx }: { ctx: RagCtx<T> }) {
  const f = ctx.form;
  const hasUpload = Boolean(f.ragUploadUrl.trim());
  return (
    <>
      <RagGroup
        title="知识库上传接口（测试知识库包模式）"
        desc="配置后运行时自动上传测试文档、等待索引就绪并在结束后清理；留空则需人工导入测试包。鉴权沿用接入配置。"
      >
        <p role="note" aria-label="上传接口影响说明" className="text-xs text-severity-high">
          注意：配置上传接口后，“已有知识库”“检索接口直评”模式也会在测试集含投毒/间接注入题时，自动把投毒测试文档
          lse-rag-poison-test.md
          上传到测试知识库（用于文档投毒与间接提示词注入检测）；配置受限知识库与受限库上传凭据后，
          还会用受限凭据上传越权哨兵文档
          lse-rag-sentinel-test.md。配置删除接口时运行结束自动删除，否则需按残留清单人工删除。
        </p>
        <RagText
          ctx={ctx}
          k="ragUploadUrl"
          label="知识库上传接口"
          placeholder="https://rag.example.com/api/kb/documents"
        />
        {hasUpload && (
          <>
            <RagSelect
              ctx={ctx}
              k="ragUploadMethod"
              label="上传方法"
              options={[
                { value: 'POST', label: 'POST' },
                { value: 'PUT', label: 'PUT' },
              ]}
            />
            <RagSelect
              ctx={ctx}
              k="ragUploadFormat"
              label="上传格式"
              options={[
                { value: 'json', label: 'JSON 请求体' },
                { value: 'multipart', label: 'multipart/form-data 文件' },
              ]}
            />
            <RagText
              ctx={ctx}
              k="ragUploadDocIdPath"
              label="文档 ID JSON 路径"
              placeholder="data.id"
              hint="上传响应中文档 ID 的位置；删除接口可用 {{document_id}}"
            />
            {f.ragUploadFormat === 'json' ? (
              <RagJson
                ctx={ctx}
                k="ragUploadTemplate"
                label="上传请求体模板"
                placeholder={DEFAULT_UPLOAD_TEMPLATE}
                hint="占位符 {{filename}}、{{content}}、{{content_base64}}、{{knowledge_base_id}}"
              />
            ) : (
              <>
                <RagText ctx={ctx} k="ragUploadFileField" label="文件字段名" placeholder="file" />
                <RagJson
                  ctx={ctx}
                  k="ragUploadFields"
                  label="multipart 附加字段"
                  placeholder={'{\n  "knowledge_base_id": "{{knowledge_base_id}}"\n}'}
                  hint="JSON 对象，值为字符串，支持同样的占位符"
                />
              </>
            )}
            <RagText
              ctx={ctx}
              k="ragRestrictedKbId"
              label="受限知识库标识"
              placeholder="kb-lse-restricted"
              hint="测试身份无权访问的知识库；配置后上传越权哨兵文档"
            />
          </>
        )}
      </RagGroup>
      {hasUpload && <DeleteAndSecret ctx={ctx} />}
      <RagGroup
        title="检索接口（检索接口直评模式）"
        desc="query → 文档片段列表；用于计算 Hit@k / MRR。未配置时该模式不可用。"
      >
        <RagText
          ctx={ctx}
          k="ragRetrievalUrl"
          label="检索接口"
          placeholder="https://rag.example.com/api/search"
        />
        {f.ragRetrievalUrl.trim() && (
          <>
            <RagSelect
              ctx={ctx}
              k="ragRetrievalMethod"
              label="检索方法"
              options={[
                { value: 'POST', label: 'POST' },
                { value: 'GET', label: 'GET（模板作为查询参数）' },
              ]}
            />
            <RagText
              ctx={ctx}
              k="ragRetrievalResultsPath"
              label="结果数组 JSON 路径"
              placeholder="data.results"
            />
            <RagText
              ctx={ctx}
              k="ragRetrievalTextField"
              label="结果原文字段名"
              placeholder="content"
            />
            <RagText
              ctx={ctx}
              k="ragRetrievalIdField"
              label="结果 ID 字段名"
              placeholder="chunk_id"
            />
            <RagText ctx={ctx} k="ragRetrievalTopK" label="检索 Top-K" placeholder="5" />
            <RagJson
              ctx={ctx}
              k="ragRetrievalTemplate"
              label="检索请求体模板"
              placeholder={DEFAULT_RETRIEVAL_TEMPLATE}
              hint="占位符 {{query}}、{{top_k}}、{{knowledge_base_id}}"
            />
          </>
        )}
      </RagGroup>
    </>
  );
}

/** 删除接口、受限库凭据（只写）、索引等待参数。 */
function DeleteAndSecret<T extends RagFormState>({ ctx }: { ctx: RagCtx<T> }) {
  const f = ctx.form;
  return (
    <>
      <RagGroup
        title="删除接口（运行后清理）"
        desc="未配置时运行结束会列出残留的测试文档，需人工删除。"
      >
        <RagText
          ctx={ctx}
          k="ragDeleteUrl"
          label="文档删除接口"
          placeholder="https://rag.example.com/api/kb/documents/{{document_id}}"
          hint="占位符 {{document_id}}、{{filename}}、{{knowledge_base_id}}"
        />
        {f.ragDeleteUrl.trim() && (
          <>
            <RagSelect
              ctx={ctx}
              k="ragDeleteMethod"
              label="删除方法"
              options={[
                { value: 'DELETE', label: 'DELETE' },
                { value: 'POST', label: 'POST' },
              ]}
            />
            <RagJson
              ctx={ctx}
              k="ragDeleteTemplate"
              label="删除请求体模板"
              placeholder={'{\n  "id": "{{document_id}}"\n}'}
            />
          </>
        )}
      </RagGroup>
      <RagGroup
        title="受限库上传凭据"
        desc="越权哨兵文档须以独立凭据写入受限库，不能使用被测身份。凭据加密保存，不回显。"
      >
        <RagText
          ctx={ctx}
          k="ragRestrictedAuthHeader"
          label="凭据请求头名"
          placeholder="Authorization"
        />
        <RagText
          ctx={ctx}
          k="ragRestrictedSecret"
          type="password"
          label="受限库上传凭据"
          placeholder={f.ragHasRestrictedSecret ? '已设置（不修改可留空）' : '如 Bearer xxx'}
          hint={
            f.ragHasRestrictedSecret ? '当前状态：已设置' : '当前状态：未设置（越权项将记“未评估”）'
          }
        />
        {f.ragHasRestrictedSecret && (
          <label className="flex items-center gap-2 text-xs sm:col-span-2">
            <input
              type="checkbox"
              checked={f.ragClearRestrictedSecret}
              onChange={(e) => ctx.setForm({ ...f, ragClearRestrictedSecret: e.target.checked })}
            />
            清除已保存的受限库上传凭据
          </label>
        )}
      </RagGroup>
      <RagGroup title="索引就绪等待" desc="上传后轮询检索，直到测试文档可被检索到再开始评估。">
        <RagText ctx={ctx} k="ragIndexTimeout" label="等待超时（秒）" placeholder="120" />
        <RagText ctx={ctx} k="ragIndexPoll" label="探测间隔（秒）" placeholder="5" />
        <RagText ctx={ctx} k="ragIndexThreshold" label="就绪比例（0–1）" placeholder="1" />
      </RagGroup>
    </>
  );
}
