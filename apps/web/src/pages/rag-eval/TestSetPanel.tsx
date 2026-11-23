import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ragEvalApi, type RagAlignmentMode, type RagTestSetSummary } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingBlock } from '@/components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatDateTime } from '@/lib/format';
import { dangerLink, linkButton } from './labels';
import { CreateTestSetModal, errMsg } from './CreateTestSetModal';
import { TestSetItems } from './TestSetItems';

function GenerationCell({ s, onCancel, canManage }: { s: RagTestSetSummary; onCancel: () => void; canManage: boolean }) {
  const st = s.generationStatus ?? 'READY';
  if (st === 'GENERATING') {
    const p = s.generationProgress;
    return (
      <span className="flex items-center gap-2 text-xs">
        <Badge tone="info">生成中</Badge>
        <span aria-label="生成进度">{p ? `${p.done}/${p.planned}（成功 ${p.generated}，失败 ${p.failed}）` : '排队中'}</span>
        {canManage && (
          <button type="button" className={dangerLink} onClick={onCancel}>
            取消生成
          </button>
        )}
      </span>
    );
  }
  if (st === 'FAILED')
    return (
      <span className="text-xs">
        <Badge tone="danger">生成失败</Badge>
        <span className="ml-1 text-slate-500">{s.generationError}</span>
      </span>
    );
  if (st === 'CANCELED') return <Badge tone="neutral">已取消（保留已生成题目）</Badge>;
  return <Badge tone="success">就绪</Badge>;
}

export function TestSetPanel({
  canManage,
  corpusId,
  corpusName,
  mode,
  judgeConfigured,
  judgeMessage,
  selectedId,
  onSelect,
  onGoStep,
}: {
  canManage: boolean;
  corpusId: string;
  corpusName: string | null;
  mode: RagAlignmentMode;
  judgeConfigured: boolean;
  judgeMessage: string | null;
  selectedId: string;
  onSelect: (id: string) => void;
  onGoStep: (s: number) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [modal, setModal] = useState<'generate' | 'empty' | null>(null);
  const sets = useQuery({
    queryKey: ['rag-eval', 'test-sets', corpusId],
    queryFn: () => ragEvalApi.testSets(corpusId),
    enabled: !!corpusId,
    refetchInterval: (q) => ((q.state.data ?? []).some((s) => s.generationStatus === 'GENERATING') ? 3000 : false),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => ragEvalApi.cancelGeneration(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['rag-eval'] }),
    onError: (e) => toast.error(errMsg(e, '取消失败')),
  });
  const remove = useMutation({
    mutationFn: (id: string) => ragEvalApi.deleteTestSet(id),
    onSuccess: () => {
      toast.success('测试集已删除');
      void qc.invalidateQueries({ queryKey: ['rag-eval'] });
    },
    onError: (e) => toast.error(errMsg(e, '删除失败')),
  });

  if (!corpusId) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-slate-600">
          请先上传测试文档。
          <button type="button" className={`ml-1 ${linkButton}`} onClick={() => onGoStep(2)}>
            上传测试文档
          </button>
        </CardContent>
      </Card>
    );
  }
  const list = sets.data ?? [];
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>4 · 测试集{corpusName ? ` · ${corpusName}` : ''}</CardTitle>
        {canManage && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setModal('empty')}>
              新建空测试集
            </Button>
            <Button size="sm" disabled={!judgeConfigured} title={judgeConfigured ? undefined : judgeMessage ?? undefined} onClick={() => setModal('generate')}>
              从知识库生成
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4 p-0">
        {sets.isLoading ? (
          <LoadingBlock />
        ) : list.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-slate-500">
            该知识库还没有测试集：点击“从知识库生成”（需配置评估模型），或“新建空测试集”后导入已有问答集、手工新增题目。
          </p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>名称</TH>
                <TH>对齐模式</TH>
                <TH>生成状态</TH>
                <TH>题目数</TH>
                <TH>种子</TH>
                <TH>创建时间</TH>
                <TH>操作</TH>
              </TR>
            </THead>
            <TBody>
              {list.map((s) => (
                <TR key={s.id} className={s.id === selectedId ? 'bg-slate-50' : undefined}>
                  <TD data-label="名称" className="font-medium">
                    {s.name}
                  </TD>
                  <TD data-label="对齐模式">{s.alignmentModeLabel ?? '—'}</TD>
                  <TD data-label="生成状态">
                    <GenerationCell s={s} canManage={canManage} onCancel={() => cancel.mutate(s.id)} />
                  </TD>
                  <TD data-label="题目数">{s.itemCount}</TD>
                  <TD data-label="种子">
                    <code className="text-xs text-slate-500">{s.seed}</code>
                  </TD>
                  <TD data-label="创建时间" className="whitespace-nowrap text-xs text-slate-500">
                    {formatDateTime(s.createdAt)}
                  </TD>
                  <TD data-label="操作">
                    <div className="flex gap-3">
                      <button type="button" className={linkButton} onClick={() => onSelect(s.id)}>
                        {s.id === selectedId ? '已选中' : '选择并查看题目'}
                      </button>
                      {canManage && (
                        <button
                          type="button"
                          className={dangerLink}
                          disabled={remove.isPending || s.runCount > 0}
                          title={s.runCount > 0 ? '已有评估运行记录，不能删除' : undefined}
                          onClick={() => {
                            if (window.confirm(`确定删除测试集“${s.name}”？`)) remove.mutate(s.id);
                          }}
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        {selectedId && list.some((s) => s.id === selectedId) && (
          <div className="border-t border-slate-100 px-5 py-4">
            <TestSetItems testSetId={selectedId} canManage={canManage} />
            <div className="mt-4">
              <Button onClick={() => onGoStep(5)}>下一步：运行与结果</Button>
            </div>
          </div>
        )}
      </CardContent>
      {modal && (
        <CreateTestSetModal
          open
          kind={modal}
          corpusId={corpusId}
          mode={mode}
          judgeConfigured={judgeConfigured}
          judgeMessage={judgeMessage}
          onClose={() => setModal(null)}
          onCreated={(id) => {
            setModal(null);
            onSelect(id);
          }}
        />
      )}
    </Card>
  );
}
