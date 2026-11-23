import { useState } from 'react';
import { Pagination } from '@/components/ui/pagination';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ragEvalApi } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingBlock } from '@/components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatDateTime, formatPercent } from '@/lib/format';
import { RAG_RUN_STATUS, dangerLink, linkButton } from './labels';
import { errMsg } from './CreateTestSetModal';

export function RunList({ onView, canRun }: { onView: (id: string) => void; canRun: boolean }) {
  const toast = useToast();
  const [page, setPage] = useState(1);
  const qc = useQueryClient();
  const runs = useQuery({
    queryKey: ['rag-eval', 'runs'],
    queryFn: () => ragEvalApi.runs(),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((r) => r.status === 'PENDING' || r.status === 'RUNNING') ? 5000 : false,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => ragEvalApi.cancelRun(id),
    onSuccess: () => {
      toast.success('已请求取消');
      void qc.invalidateQueries({ queryKey: ['rag-eval', 'runs'] });
    },
    onError: (e) => toast.error(errMsg(e, '取消失败')),
  });
  const rows = runs.data ?? [];
  const currentPage = Math.min(page, Math.max(1, Math.ceil(rows.length / 10)));
  return (
    <Card>
      <CardHeader>
        <CardTitle>运行记录</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {runs.isLoading ? (
          <LoadingBlock />
        ) : (runs.data ?? []).length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-slate-500">还没有运行记录：在上方选择测试集与评估对象后发起评估。</p>
        ) : (
          <>
          <Table>
            <THead>
              <TR>
                <TH>评估对象</TH>
                <TH>测试集</TH>
                <TH>对齐模式</TH>
                <TH>状态</TH>
                <TH>进度</TH>
                <TH>发起时间</TH>
                <TH>操作</TH>
              </TR>
            </THead>
            <TBody>
              {rows.slice((currentPage - 1) * 10, currentPage * 10).map((r) => {
                const st = RAG_RUN_STATUS[r.status] ?? { label: r.status, tone: 'neutral' as const };
                const active = r.status === 'PENDING' || r.status === 'RUNNING';
                return (
                  <TR key={r.id}>
                    <TD data-label="评估对象" className="font-medium">
                      {r.modelTargetName}
                    </TD>
                    <TD data-label="测试集">{r.testSetName}</TD>
                    <TD data-label="对齐模式">{r.alignmentModeLabel ?? '—'}</TD>
                    <TD data-label="状态">
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </TD>
                    <TD data-label="进度">
                      {r.processed}/{r.total}（{formatPercent(r.progress, 0)}）
                    </TD>
                    <TD data-label="发起时间" className="whitespace-nowrap text-xs text-slate-500">
                      {formatDateTime(r.createdAt)}
                    </TD>
                    <TD data-label="操作">
                      <div className="flex gap-3">
                        <button type="button" className={linkButton} onClick={() => onView(r.id)}>
                          查看结果
                        </button>
                        {canRun && active && (
                          <button
                            type="button"
                            className={dangerLink}
                            disabled={cancel.isPending}
                            onClick={() => cancel.mutate(r.id)}
                          >
                            取消
                          </button>
                        )}
                      </div>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
          <div className="px-5 pb-4"><Pagination page={currentPage} pageSize={10} total={rows.length} onPageChange={setPage} /></div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
