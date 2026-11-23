import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ragEvalApi, type RagItemType, type RagTestItem } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { RAG_QUALITY_TYPES, RAG_SECURITY_TYPES, ragTypeLabel } from './labels';
import { errMsg } from './CreateTestSetModal';

const ALL_TYPES = [...RAG_QUALITY_TYPES, ...RAG_SECURITY_TYPES] as RagItemType[];

interface Draft {
  type: RagItemType;
  question: string;
  referenceAnswer: string;
  sourceChunkIds: string[];
}

/** 新增/编辑单题；来源切块从知识库切块摘要中多选。 */
export function ItemEditModal({
  testSetId,
  corpusId,
  item,
  onClose,
}: {
  testSetId: string;
  corpusId: string;
  /** null 表示新增。 */
  item: RagTestItem | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => ({
    type: item?.type ?? 'FACT',
    question: item?.question ?? '',
    referenceAnswer: item?.referenceAnswer ?? '',
    sourceChunkIds: item?.sourceChunkIds ?? [],
  }));
  const chunks = useQuery({
    queryKey: ['rag-eval', 'corpus-chunks', corpusId],
    queryFn: () => ragEvalApi.corpusChunks(corpusId),
    enabled: !!corpusId,
  });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        type: draft.type,
        question: draft.question.trim(),
        referenceAnswer: draft.referenceAnswer.trim() || null,
        sourceChunkIds: draft.sourceChunkIds,
      };
      return item
        ? ragEvalApi.updateItem(testSetId, item.id, body)
        : ragEvalApi.createItem(testSetId, body);
    },
    onSuccess: () => {
      toast.success(item ? '题目已更新' : '题目已新增');
      void qc.invalidateQueries({ queryKey: ['rag-eval'] });
      onClose();
    },
    onError: (e) => toast.error(errMsg(e, '保存失败')),
  });
  const isSecurity = (RAG_SECURITY_TYPES as readonly string[]).includes(draft.type);

  return (
    <Modal
      open
      onClose={onClose}
      title={item ? '编辑题目' : '新增题目'}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!draft.question.trim() || save.isPending} onClick={() => save.mutate()}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="题型" htmlFor="rag-item-type">
          <Select
            id="rag-item-type"
            value={draft.type}
            onChange={(e) => setDraft({ ...draft, type: e.target.value as RagItemType })}
          >
            {ALL_TYPES.map((t) => (
              <option key={t} value={t}>
                {ragTypeLabel(t)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="问题" htmlFor="rag-item-q" required>
          <Textarea
            id="rag-item-q"
            rows={3}
            value={draft.question}
            onChange={(e) => setDraft({ ...draft, question: e.target.value })}
          />
        </Field>
        <Field
          label="参考答案"
          htmlFor="rag-item-a"
          hint={isSecurity ? '安全题按测试集种子自动生成判定依据，无需填写' : '无答案题留空'}
        >
          <Textarea
            id="rag-item-a"
            rows={3}
            value={draft.referenceAnswer}
            onChange={(e) => setDraft({ ...draft, referenceAnswer: e.target.value })}
          />
        </Field>
        {!isSecurity && (
          <Field label="来源切块" hint="用于引用准确性与检索命中判定；多跳题选两段及以上">
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2 text-xs">
              {(chunks.data ?? []).length === 0 && (
                <p className="text-slate-500">知识库暂无切块，请先在第 2 步上传文档</p>
              )}
              {(chunks.data ?? []).map((c) => (
                <label key={c.id} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={draft.sourceChunkIds.includes(c.id)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        sourceChunkIds: e.target.checked
                          ? [...draft.sourceChunkIds, c.id]
                          : draft.sourceChunkIds.filter((x) => x !== c.id),
                      })
                    }
                  />
                  <span>
                    <span className="font-medium">
                      {c.filename} #{c.seq + 1}
                    </span>{' '}
                    <span className="text-slate-500">{c.preview}</span>
                  </span>
                </label>
              ))}
            </div>
          </Field>
        )}
      </div>
    </Modal>
  );
}
