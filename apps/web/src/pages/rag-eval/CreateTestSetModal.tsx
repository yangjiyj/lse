import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, ragEvalApi, type RagAlignmentMode } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { RAG_QUALITY_TYPES, ragTypeLabel } from './labels';
import { MODE_DETAIL } from './ModeStep';

type QualityType = (typeof RAG_QUALITY_TYPES)[number];

export function errMsg(e: unknown, fallback: string) {
  return e instanceof ApiError ? e.message : fallback;
}

/** 新建测试集：从知识库异步生成（需评估模型），或新建空测试集后手工录入/导入。 */
export function CreateTestSetModal({
  open,
  kind,
  corpusId,
  mode,
  judgeConfigured,
  judgeMessage,
  onClose,
  onCreated,
}: {
  open: boolean;
  kind: 'generate' | 'empty';
  corpusId: string;
  mode: RagAlignmentMode;
  judgeConfigured: boolean;
  judgeMessage: string | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [seed, setSeed] = useState('');
  const [includeSecurity, setIncludeSecurity] = useState(true);
  const [counts, setCounts] = useState<Record<QualityType, number>>({
    FACT: 5,
    MULTI_HOP: 3,
    NO_ANSWER: 3,
    DISTRACTOR: 3,
  });
  const total = RAG_QUALITY_TYPES.reduce((n, t) => n + (counts[t] || 0), 0);

  const create = useMutation({
    mutationFn: () =>
      kind === 'generate'
        ? ragEvalApi.generateTestSet(corpusId, {
            name: name.trim(),
            seed: seed.trim() || undefined,
            alignmentMode: mode,
            counts,
            includeSecurity,
          })
        : ragEvalApi.createEmptyTestSet(corpusId, {
            name: name.trim(),
            alignmentMode: mode,
            includeSecurity,
          }),
    onSuccess: (r) => {
      toast.success(kind === 'generate' ? '已开始生成，可在列表查看进度' : '测试集已创建');
      setName('');
      onCreated(r.id);
      void qc.invalidateQueries({ queryKey: ['rag-eval'] });
    },
    onError: (e) => toast.error(errMsg(e, kind === 'generate' ? '生成失败' : '创建失败')),
  });

  const needsJudge = kind === 'generate' && total > 0 && !judgeConfigured;
  const disabled =
    !name.trim() ||
    create.isPending ||
    needsJudge ||
    (kind === 'generate' && total === 0 && !includeSecurity);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={kind === 'generate' ? '从知识库生成测试集' : '新建空测试集'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={disabled} onClick={() => create.mutate()}>
            {create.isPending ? '提交中…' : kind === 'generate' ? '开始生成' : '创建'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-slate-500">
          知识对齐模式：{MODE_DETAIL[mode].label}（可在“知识对齐”中修改）
        </p>
        <Field label="名称" htmlFor="rag-set-name" required>
          <Input
            id="rag-set-name"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        {kind === 'generate' && (
          <>
            <div className="grid grid-cols-2 gap-3">
              {RAG_QUALITY_TYPES.map((t) => (
                <Field key={t} label={ragTypeLabel(t)} htmlFor={`rag-count-${t}`}>
                  <Input
                    id={`rag-count-${t}`}
                    type="number"
                    min={0}
                    max={100}
                    value={counts[t]}
                    onChange={(e) =>
                      setCounts((c) => ({
                        ...c,
                        [t]: Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                      }))
                    }
                  />
                </Field>
              ))}
            </div>
            <p className="text-xs text-slate-500">
              多跳题要求两段切块共享关键实体；无答案题会在全部文档中反证，确认文档中确实没有答案；与已有题目近似的会被剔除。
            </p>
            <Field label="随机种子（选填，便于复现）" htmlFor="rag-set-seed">
              <Input
                id="rag-set-seed"
                value={seed}
                maxLength={100}
                onChange={(e) => setSeed(e.target.value)}
              />
            </Field>
          </>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeSecurity}
            onChange={(e) => setIncludeSecurity(e.target.checked)}
          />
          包含安全题（文档投毒、间接提示词注入、越权读取其他文档）
        </label>
        {needsJudge && <p className="text-sm text-severity-critical">{judgeMessage}</p>}
      </div>
    </Modal>
  );
}
