import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type ModelTarget, type RagAlignmentMode } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { isRagEligibleTargetType } from '../model-targets/RagTargetFields';
import { RagTargetModal } from './RagTargetModal';

/** 可声明但尚未声明为 RAG 应用的评估对象（仅智能体应用 API 类）。 */
function useConvertibleTargets(enabled: boolean) {
  return useQuery({
    queryKey: ['model-targets', 'rag-convertible'],
    queryFn: () => api.modelTargets.list({ page: 1, pageSize: 200 }),
    enabled,
    select: (page) => page.items.filter((t) => isRagEligibleTargetType(t.targetType) && !t.isRag),
  });
}

/** 接入说明收进提示，保留对象管理入口。 */
export function RagTargetExplain() {
  return (
    <p role="note" aria-label="RAG 评估对象说明" title="请选择能返回检索上下文与引用来源的应用；纯模型接口不连接知识库。" className="text-xs leading-5 text-slate-500">
      <Link to="/model-targets" className="mx-1 text-brand-600 hover:underline">
        评估对象
      </Link>
    </p>
  );
}

/** 选择评估对象处的入口：新建 RAG 评估对象 / 将已有评估对象设为 RAG 应用。 */
export function RagTargetEntry({
  mode,
  onCreated,
}: {
  mode: RagAlignmentMode;
  onCreated: (id: string) => void;
}) {
  const { hasPermission } = useAuth();
  const canCreate = hasPermission('model_target:create');
  const canUpdate = hasPermission('model_target:update') && hasPermission('model_target:read');
  const qc = useQueryClient();
  const convertible = useConvertibleTargets(canUpdate);
  const [pickId, setPickId] = useState('');
  const [modal, setModal] = useState<{ target: ModelTarget | null } | null>(null);
  const options = convertible.data ?? [];

  if (!canCreate && !canUpdate) {
    return <p className="text-sm text-slate-600">请联系管理员配置 RAG 评估对象。</p>;
  }

  const onSaved = async (saved: ModelTarget) => {
    qc.removeQueries({ queryKey: ['rag-eval', 'connection'] });
    setModal(null);
    setPickId('');
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['rag-eval', 'targets'] }),
      qc.invalidateQueries({ queryKey: ['model-targets'] }),
    ]);
    onCreated(saved.id);
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      {canCreate && (
        <Button variant="outline" onClick={() => setModal({ target: null })}>
          新建 RAG 评估对象
        </Button>
      )}
      {canUpdate && options.length > 0 && (
        <div className="flex items-center gap-2">
          <Select
            aria-label="可设为 RAG 应用的评估对象"
            value={pickId}
            onChange={(e) => setPickId(e.target.value)}
            className="w-56"
          >
            <option value="">选择已有智能体应用 API 对象</option>
            {options.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          <Button
            variant="outline"
            disabled={!pickId}
            onClick={() => setModal({ target: options.find((t) => t.id === pickId) ?? null })}
          >
            将已有评估对象设为 RAG 应用
          </Button>
        </div>
      )}
      {modal && (
        <RagTargetModal
          key={modal.target?.id ?? 'new'}
          open
          mode={mode}
          target={modal.target}
          onClose={() => setModal(null)}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}
