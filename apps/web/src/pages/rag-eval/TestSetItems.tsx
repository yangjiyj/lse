import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ragEvalApi, type RagTestItem } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { LoadingBlock } from '@/components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { RAG_QUALITY_TYPES, RAG_SECURITY_TYPES, dangerLink, linkButton, ragTypeLabel } from './labels';
import { errMsg } from './CreateTestSetModal';
import { ItemEditModal } from './ItemEditModal';

const ALL_TYPES = [...RAG_QUALITY_TYPES, ...RAG_SECURITY_TYPES];

/** 测试集题目：增删改、CSV/JSONL 导入导出、测试知识库包下载。 */
export function TestSetItems({ testSetId, canManage }: { testSetId: string; canManage: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<RagTestItem | null | undefined>(undefined);
  const detail = useQuery({
    queryKey: ['rag-eval', 'test-set', testSetId],
    queryFn: () => ragEvalApi.testSet(testSetId),
  });
  const remove = useMutation({
    mutationFn: (itemId: string) => ragEvalApi.deleteItem(testSetId, itemId),
    onSuccess: () => {
      toast.success('题目已删除');
      void qc.invalidateQueries({ queryKey: ['rag-eval'] });
    },
    onError: (e) => toast.error(errMsg(e, '删除失败')),
  });
  const importMut = useMutation({
    mutationFn: async (file: File) => {
      const format = file.name.toLowerCase().endsWith('.jsonl') ? 'jsonl' : 'csv';
      return ragEvalApi.importItems(testSetId, { format, content: await file.text() });
    },
    onSuccess: (r) => {
      toast.success(`已导入 ${r.imported} 题${r.duplicates ? `，剔除重复 ${r.duplicates} 题` : ''}`);
      void qc.invalidateQueries({ queryKey: ['rag-eval'] });
    },
    onError: (e) => toast.error(errMsg(e, '导入失败')),
  });
  const download = (p: Promise<void>) => p.catch((e) => toast.error(errMsg(e, '下载失败')));

  if (detail.isLoading || !detail.data) return <LoadingBlock />;
  const d = detail.data;
  const generating = d.generationStatus === 'GENERATING';
  const editable = canManage && !generating;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {canManage ? (
          <Button size="sm" onClick={() => download(ragEvalApi.downloadTestPackage(testSetId))}>
            下载测试知识库包（zip）
          </Button>
        ) : (
          <span className="text-sm text-slate-500">测试知识库包含投毒/越权哨兵文档原文，需“维护 RAG 知识库与测试集”权限才能下载</span>
        )}
        <button type="button" className={linkButton} onClick={() => download(ragEvalApi.exportItems(testSetId, 'csv'))}>
          导出 CSV
        </button>
        <button type="button" className={linkButton} onClick={() => download(ragEvalApi.exportItems(testSetId, 'jsonl'))}>
          导出 JSONL
        </button>
        {editable && (
          <>
            <button type="button" className={linkButton} onClick={() => setEditing(null)}>
              新增题目
            </button>
            <button
              type="button"
              className={linkButton}
              disabled={importMut.isPending}
              onClick={() => fileRef.current?.click()}
            >
              导入 CSV/JSONL
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.jsonl"
              aria-label="选择导入文件"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importMut.mutate(f);
                e.target.value = '';
              }}
            />
          </>
        )}
      </div>
      <p className="text-xs text-slate-500">
        下载的测试知识库包包含安全测试文档，只能导入专用测试知识库。
      </p>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-600">
        {ALL_TYPES.map((t) => (
          <span key={t}>
            {ragTypeLabel(t)}：{d.items.filter((i) => i.type === t).length}
          </span>
        ))}
      </div>
      {d.items.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">
          测试集还没有题目：可“从知识库生成”（需评估模型）、导入已有问答集，或手工新增。
        </p>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>题型</TH>
              <TH>问题</TH>
              <TH>参考答案</TH>
              <TH>来源</TH>
              {editable && <TH>操作</TH>}
            </TR>
          </THead>
          <TBody>
            {d.items.map((i) => (
              <TR key={i.id}>
                <TD data-label="题型" className="whitespace-nowrap">
                  {ragTypeLabel(i.type)}
                </TD>
                <TD data-label="问题">{i.question}</TD>
                <TD data-label="参考答案" className="text-slate-600">
                  {i.referenceAnswer ?? '—'}
                </TD>
                <TD data-label="来源" className="text-xs text-slate-500">
                  {i.sourceChunkIds.length === 0
                    ? '—'
                    : i.sourceChunkIds
                        .map((id) => d.sources.find((s) => s.id === id))
                        .filter(Boolean)
                        .map((s) => `${s!.filename} #${s!.seq + 1}`)
                        .join('、')}
                </TD>
                {editable && (
                  <TD data-label="操作">
                    <div className="flex gap-3">
                      <button type="button" className={linkButton} onClick={() => setEditing(i)}>
                        编辑
                      </button>
                      <button
                        type="button"
                        className={dangerLink}
                        disabled={remove.isPending}
                        onClick={() => {
                          if (window.confirm('确定删除该题目？')) remove.mutate(i.id);
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </TD>
                )}
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {editing !== undefined && (
        <ItemEditModal testSetId={testSetId} corpusId={d.corpus.id} item={editing} onClose={() => setEditing(undefined)} />
      )}
    </div>
  );
}
