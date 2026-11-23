import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_RAG_FORM,
  RagTargetFields,
  buildRagPayload,
  ragFormFields,
  type RagFormState,
} from './RagTargetFields';

function Harness({
  onChange,
  targetType = 'AGENT_API',
  initial = EMPTY_RAG_FORM,
}: {
  onChange: (f: RagFormState) => void;
  targetType?: string;
  initial?: RagFormState;
}) {
  const [form, setForm] = useState(initial);
  return (
    <MemoryRouter>
      <RagTargetFields
        targetType={targetType}
        form={form}
        setForm={(next) => {
          setForm(next);
          onChange(next);
        }}
      />
    </MemoryRouter>
  );
}

const CREATE = { eligible: true, patch: false };
const PATCH = { eligible: true, patch: true };

describe('RagTargetFields', () => {
  it('勾选后按分组展示上下文/引用/上传/检索配置', async () => {
    let last = EMPTY_RAG_FORM;
    render(<Harness onChange={(f) => (last = f)} />);
    expect(screen.queryByLabelText('检索上下文 JSON 路径')).toBeNull();
    await userEvent.click(screen.getByLabelText('声明为 RAG 应用（开放 RAG 专项评估）'));
    await userEvent.type(screen.getByLabelText('检索上下文 JSON 路径'), 'data.contexts');
    await userEvent.type(screen.getByLabelText('引用 ID 字段名'), 'doc_id');
    expect(last.ragContextPath).toBe('data.contexts');
    expect(last.ragCitationIdField).toBe('doc_id');
    expect(screen.queryByLabelText('上传格式')).toBeNull();
    await userEvent.type(screen.getByLabelText('知识库上传接口'), 'https://rag.example.com/kb');
    await userEvent.selectOptions(screen.getByLabelText('上传格式'), 'multipart');
    expect(screen.getByLabelText('文件字段名')).toBeInTheDocument();
    expect(screen.getByLabelText('文档删除接口')).toBeInTheDocument();
    expect(screen.getByLabelText('受限库上传凭据')).toHaveAttribute('type', 'password');
    expect(screen.queryByLabelText('结果数组 JSON 路径')).toBeNull();
    await userEvent.type(screen.getByLabelText('检索接口'), 'https://rag.example.com/search');
    expect(screen.getByLabelText('结果数组 JSON 路径')).toBeInTheDocument();
  });

  it('上传接口分组说明：其他模式也会自动上传投毒/哨兵测试文档及清理行为', async () => {
    render(<Harness onChange={() => {}} />);
    await userEvent.click(screen.getByLabelText('声明为 RAG 应用（开放 RAG 专项评估）'));
    const note = screen.getByRole('note', { name: '上传接口影响说明' });
    expect(note.textContent).toMatch(/“已有知识库”“检索接口直评”模式也会.*自动把投毒测试文档/);
    expect(note.textContent).toMatch(/lse-rag-poison-test\.md/);
    expect(note.textContent).toMatch(/lse-rag-sentinel-test\.md/);
    expect(note.textContent).toMatch(/配置删除接口时运行结束自动删除，否则需按残留清单人工删除/);
  });

  it('非智能体应用 API 类不可勾选并说明原因', () => {
    render(<Harness onChange={() => {}} targetType="PUBLIC_AGENT" initial={{ ...EMPTY_RAG_FORM, isRag: true }} />);
    const box = screen.getByLabelText('声明为 RAG 应用（开放 RAG 专项评估）');
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
    expect(screen.getByText(/仅“智能体应用 API（自定义 HTTP）”类评估对象可声明为 RAG 应用/)).toBeInTheDocument();
    expect(screen.getByText(/页直接新建 RAG 评估对象/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'RAG 专项评估' })).toHaveAttribute('href', '/inspect/rag');
    expect(screen.queryByLabelText('检索上下文 JSON 路径')).toBeNull();
    expect(
      buildRagPayload({ ...EMPTY_RAG_FORM, isRag: true, ragContextPath: 'x' }, { eligible: false, patch: true }),
    ).toEqual({ ok: true, isRag: false });
  });

  it('已设置受限凭据时只显示状态、可清除，不回显', async () => {
    let last = EMPTY_RAG_FORM;
    const initial = { ...EMPTY_RAG_FORM, isRag: true, ragUploadUrl: 'https://x/kb', ragHasRestrictedSecret: true };
    render(<Harness onChange={(f) => (last = f)} initial={initial} />);
    expect(screen.getByLabelText('受限库上传凭据')).toHaveValue('');
    expect(screen.getByText('当前状态：已设置')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('清除已保存的受限库上传凭据'));
    expect(buildRagPayload(last, PATCH)).toMatchObject({ ok: true, ragRestrictedUploadSecret: null });
    expect(buildRagPayload(initial, PATCH)).not.toHaveProperty('ragRestrictedUploadSecret');
  });
});

describe('buildRagPayload', () => {
  it('未声明时不提交 ragOptions；模板非法与检索缺结果路径时报错', () => {
    expect(buildRagPayload(EMPTY_RAG_FORM, CREATE)).toEqual({ ok: true, isRag: false });
    expect(
      buildRagPayload({ ...EMPTY_RAG_FORM, isRag: true, ragUploadUrl: 'https://x/kb', ragUploadTemplate: '[' }, CREATE),
    ).toEqual({ ok: false, error: '知识库上传请求体模板需为 JSON 对象' });
    expect(
      buildRagPayload({ ...EMPTY_RAG_FORM, isRag: true, ragRetrievalUrl: 'https://x/search' }, CREATE),
    ).toEqual({ ok: false, error: '配置检索接口时需填写结果数组 JSON 路径' });
    expect(buildRagPayload({ ...EMPTY_RAG_FORM, isRag: true, ragIndexThreshold: '2' }, CREATE)).toEqual({
      ok: false,
      error: '索引就绪比例需为 0–1 之间的数值',
    });
  });

  it('新建只提交非空项，测试库标识放顶层，凭据随提交', () => {
    const r = buildRagPayload(
      {
        ...EMPTY_RAG_FORM,
        isRag: true,
        ragMode: 'TEST_PACKAGE',
        ragTestKbId: 'kb1',
        ragContextPath: 'contexts',
        ragUploadUrl: 'https://x/kb',
        ragUploadFormat: 'multipart',
        ragUploadFileField: 'file',
        ragUploadFields: '{"kb":"{{knowledge_base_id}}"}',
        ragRestrictedKbId: 'kb-secret',
        ragRestrictedSecret: 'Bearer s3',
        ragRetrievalTopK: '3',
      },
      CREATE,
    );
    expect(r).toEqual({
      ok: true,
      isRag: true,
      ragRestrictedUploadSecret: 'Bearer s3',
      ragOptions: {
        defaultAlignmentMode: 'TEST_PACKAGE',
        testKnowledgeBaseId: 'kb1',
        contextPath: 'contexts',
        knowledgeUpload: {
          url: 'https://x/kb',
          method: 'POST',
          format: 'multipart',
          multipartFileField: 'file',
          multipartFields: { kb: '{{knowledge_base_id}}' },
          restrictedKnowledgeBaseId: 'kb-secret',
        },
      },
    });
  });

  it('编辑按合并补丁提交：清空项传 null，旧字段迁移并清理', () => {
    const form = ragFormFields({
      isRag: true,
      ragOptions: {
        citationPath: 'refs',
        knowledgeUpload: { url: 'https://x/kb', testKnowledgeBaseId: 'kb-old', bodyTemplate: { a: 1 } },
      },
    });
    expect(form.ragTestKbId).toBe('kb-old');
    expect(JSON.parse(form.ragUploadTemplate)).toEqual({ a: 1 });
    const r = buildRagPayload({ ...form, ragCitationPath: '' }, PATCH);
    if (!r.ok) throw new Error(r.error);
    const o = r.ragOptions as Record<string, unknown>;
    expect(o.citationPath).toBeNull();
    expect(o.testKnowledgeBaseId).toBe('kb-old');
    expect(o.retrieval).toBeNull();
    expect(o.knowledgeUpload).toMatchObject({ url: 'https://x/kb', bodyTemplate: { a: 1 }, testKnowledgeBaseId: null });
  });
});
