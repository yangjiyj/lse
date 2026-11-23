import { buildDifyPreset, type DifyPresetKind } from '../../../../../packages/shared/src/rag-presets';
import { Select } from '@/components/ui/select';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, type ModelTarget, type RagAlignmentMode } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import {
  AgentApiAccessFields,
  EMPTY_AGENT_ACCESS,
  buildAgentAccessConfig,
  type AgentApiAccessState,
} from '../model-targets/AgentApiAccessFields';
import {
  EMPTY_RAG_FORM,
  RagTargetFields,
  buildRagPayload,
  ragFormFields,
  type RagFormState,
} from '../model-targets/RagTargetFields';
import { errMsg } from './CreateTestSetModal';

type RagTargetForm = AgentApiAccessState & RagFormState & { name: string };

function initialForm(mode: RagAlignmentMode, target: ModelTarget | null): RagTargetForm {
  if (!target) return { name: '', ...EMPTY_AGENT_ACCESS, ...EMPTY_RAG_FORM, isRag: true, ragMode: mode };
  const rag = ragFormFields(target);
  return { name: target.name, ...EMPTY_AGENT_ACCESS, ...rag, isRag: true, ragMode: rag.ragMode || mode };
}

/**
 * 在 RAG 专项评估页新建或转换评估对象：接入方式固定为智能体应用 API（自定义 HTTP），默认声明为 RAG 应用。
 * - 新建：复用评估对象表单的接入字段与 RAG 字段，走评估对象创建接口；
 * - 转换（target 非空）：只提交 RAG 声明与配置（合并补丁），接入配置沿用已保存值。
 */
export function RagTargetModal({
  open,
  mode,
  target,
  onClose,
  onSaved,
}: {
  open: boolean;
  mode: RagAlignmentMode;
  target: ModelTarget | null;
  onClose: () => void;
  onSaved: (saved: ModelTarget) => void | Promise<void>;
}) {
  const toast = useToast();
  const [form, setForm] = useState<RagTargetForm>(() => initialForm(mode, target));
  const converting = Boolean(target);
  const [kind, setKind] = useState<'custom' | DifyPresetKind>('custom');
  const [applicationUrl, setApplicationUrl] = useState('');
  const selectPreset = (next: 'custom' | DifyPresetKind) => {
    setKind(next);
    if (next === 'custom') return;
    const p = buildDifyPreset(next, 'http://localhost', '');
    setForm({ ...form, authType: 'bearer', customHeaders: '', sessionHeaderName: '',
      requestTemplate: JSON.stringify(p.accessConfig.requestTemplate, null, 2),
      responseTextPath: p.accessConfig.responseTextPath,
      ragContextPath: p.ragOptions.contextPath ?? '',
      ragContextTextField: p.ragOptions.contextTextField ?? '',
      ragContextIdField: p.ragOptions.contextIdField ?? '',
      ragCitationPath: p.ragOptions.citationPath ?? '',
      ragCitationTextField: p.ragOptions.citationTextField ?? '',
      ragCitationIdField: p.ragOptions.citationIdField ?? '',
    });
  };

  const save = useMutation({
    mutationFn: async () => {
      const rag = buildRagPayload(form, { eligible: true, patch: converting });
      if (!rag.ok) throw new FormError(rag.error);
      const ragBody: Record<string, unknown> = { isRag: true };
      if (rag.ragOptions !== undefined) ragBody.ragOptions = rag.ragOptions;
      if (rag.ragRestrictedUploadSecret !== undefined) {
        ragBody.ragRestrictedUploadSecret = rag.ragRestrictedUploadSecret;
      }
      if (target) return api.modelTargets.update(target.id, ragBody);
      const access = buildAgentAccessConfig(form);
      if (!access.ok) throw new FormError(access.error);
      return api.modelTargets.create({
        name: form.name.trim(),
        targetType: 'AGENT_API',
        provider: 'custom-agent',
        model: 'agent-api',
        baseUrl: kind === 'custom' ? form.baseUrl.trim() : buildDifyPreset(kind, applicationUrl, form.apiKey).baseUrl,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
        accessConfig: access.accessConfig,
        isActive: true,
        isGlobal: false,
        ...ragBody,
      });
    },
    onSuccess: async (saved) => {
      toast.success(converting ? '已设为 RAG 应用' : 'RAG 评估对象已创建');
      await onSaved(saved);
    },
    onError: (e) => toast.error(e instanceof FormError ? e.message : errMsg(e, '保存失败')),
  });

  const canSubmit = converting || Boolean(form.name.trim() && (kind === 'custom' ? form.baseUrl.trim() : applicationUrl.trim() && form.apiKey.trim()));

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={converting ? `将“${target!.name}”设为 RAG 应用` : '新建 RAG 评估对象'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!canSubmit || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {converting ? (
          <p className="text-sm text-slate-600 sm:col-span-2">
            接口地址、鉴权、请求模板与回答路径沿用已保存配置；如需修改，请到评估对象页编辑。
          </p>
        ) : (
          <>
            <Field label="对象名称" htmlFor="rag-target-name" required className="sm:col-span-2">
              <Input
                id="rag-target-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="客服知识库助手"
              />
            </Field>
            <Field label="应用类型" htmlFor="rag-app-kind" className="sm:col-span-2">
              <Select id="rag-app-kind" value={kind} onChange={e => selectPreset(e.target.value as typeof kind)}>
                <option value="custom">自定义</option>
                <option value="chat">Dify 对话应用</option>
                <option value="workflow">Dify 工作流应用</option>
              </Select>
            </Field>
            {kind !== 'custom' && <>
              <Field label="应用地址" htmlFor="rag-dify-url" required>
                <Input id="rag-dify-url" value={applicationUrl} onChange={e => setApplicationUrl(e.target.value)} placeholder="http://host:18094" />
              </Field>
              <Field label="应用 API Key" htmlFor="rag-dify-key" required>
                <Input id="rag-dify-key" type="password" autoComplete="new-password" value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} />
              </Field>
              {kind === 'workflow' && <p className="text-sm text-ink-3 sm:col-span-2">默认输入变量为 query、输出变量为 text；名称不同时请展开高级设置修改。</p>}
            </>}
            {kind === 'custom' && <AgentApiAccessFields form={form} setForm={setForm} withEndpoint />}
          </>
        )}
        {kind === 'custom' ? <RagTargetFields form={form} setForm={setForm} targetType="AGENT_API" lockDeclared /> :
          <details className="sm:col-span-2">
            <summary className="cursor-pointer text-sm text-brand-600">高级设置</summary>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <AgentApiAccessFields form={form} setForm={setForm} />
              <RagTargetFields form={form} setForm={setForm} targetType="AGENT_API" lockDeclared />
            </div>
          </details>}

      </div>
    </Modal>
  );
}

class FormError extends Error {}
