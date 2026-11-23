import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';

export interface RegisterDraft {
  baseUrl: string;
  model: string;
  serviceLabel: string;
}

/** 一键登记为评估对象：预填地址/模型/类型，走现有 POST /model-targets 的校验与权限。 */
export function RegisterTargetModal({
  draft,
  onClose,
}: {
  draft: RegisterDraft | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('EMPTY');
  const [lastDraft, setLastDraft] = useState<RegisterDraft | null>(null);

  if (draft !== lastDraft) {
    setLastDraft(draft);
    if (draft) {
      setName(`${draft.serviceLabel} ${draft.model || new URL(draft.baseUrl).host}`.slice(0, 100));
      setBaseUrl(draft.baseUrl);
      setModel(draft.model);
      setApiKey('EMPTY');
    }
  }

  const create = useMutation({
    mutationFn: () =>
      api.modelTargets.create({
        name: name.trim(),
        targetType: 'MODEL',
        provider: 'openai-compatible-local',
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey,
      }),
    onSuccess: () => {
      toast.success('已登记为评估对象');
      void qc.invalidateQueries({ queryKey: ['asset-discovery'] });
      void qc.invalidateQueries({ queryKey: ['model-targets'] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : '登记失败'),
  });

  return (
    <Modal
      open={!!draft}
      onClose={onClose}
      title="登记为评估对象"
      description="按本地模型服务（OpenAI 兼容接口）登记；本地服务不校验密钥时可保留 EMPTY。"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={create.isPending || !name.trim() || !baseUrl.trim() || !model.trim()}
          >
            {create.isPending ? '登记中…' : '确认登记'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="对象名称" htmlFor="asset-register-name" required>
          <Input id="asset-register-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="接口地址" htmlFor="asset-register-url" required>
          <Input
            id="asset-register-url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </Field>
        <Field label="模型标识" htmlFor="asset-register-model" required>
          <Input
            id="asset-register-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </Field>
        <Field label="访问密钥" htmlFor="asset-register-key" required>
          <Input
            id="asset-register-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
