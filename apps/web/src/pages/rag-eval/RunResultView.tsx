import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ragEvalApi, type RagEvalResult, type RagEvalRunDetail } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { LoadingBlock } from '@/components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatDateTime } from '@/lib/format';
import {
  RAG_QUALITY_TYPES,
  RAG_RUN_STATUS,
  RAG_SECURITY_TYPES,
  RAG_VERDICT,
  linkButton,
  ragTypeLabel,
} from './labels';
import { RunGroups } from './RunGroups';
import { ResultDrill } from './ResultDrill';

const PAGE_SIZE = 20;

function VerdictBadge({ r }: { r: RagEvalResult }) {
  if (r.status === 'RESTRICTED') return <Badge tone="neutral">未评估</Badge>;
  if (r.needsReview) return <Badge tone="warning">需人工复核</Badge>;
  const v = RAG_VERDICT[r.verdict] ?? { label: r.verdict, tone: 'neutral' as const };
  return <Badge tone={v.tone}>{v.label}</Badge>;
}

/** 对齐、索引探测、清理：说明本次结果的前提是否成立，以及是否有残留文档。 */
function RunPreconditions({ r }: { r: RagEvalRunDetail }) {
  const probe = r.indexProbe;
  const cleanup = r.cleanup;
  return (
    <section aria-label="运行前提" className="space-y-1 text-sm text-slate-700">
      <p>
        知识对齐模式：{r.alignmentModeLabel ?? '—'}
        {r.alignmentConfirmedByName && (
          <span className="ml-2 text-xs text-slate-500">
            已由 {r.alignmentConfirmedByName} 于 {formatDateTime(r.alignmentConfirmedAt ?? '')}{' '}
            确认对齐
          </span>
        )}
        {r.alignmentMode === 'TEST_PACKAGE' && r.packageImported && (
          <span className="ml-2 text-xs text-slate-500">测试知识库包：已手工导入</span>
        )}
      </p>
      {probe && (
        <p className={probe.ready ? 'text-severity-pass' : 'text-severity-critical'}>
          索引就绪探测：{probe.ready ? '通过' : '未通过'}（命中 {Math.round(probe.hitRate * 100)}
          %，阈值 {Math.round(probe.threshold * 100)}%，{probe.attempts} 次，
          {Math.round(probe.elapsedMs / 1000)} 秒）
          {probe.error && <span className="ml-1 text-slate-500">{probe.error}</span>}
        </p>
      )}
      {cleanup && (
        <div className={cleanup.ok ? 'text-severity-pass' : 'text-severity-critical'}>
          {cleanup.ok ? `已清理测试文档 ${cleanup.deleted} 个` : cleanup.reason}
          {cleanup.residual.length > 0 && (
            <ul aria-label="残留清单" className="mt-1 list-inside list-disc text-xs text-slate-600">
              {cleanup.residual.map((x, i) => (
                <li key={i}>
                  {x.filename}（知识库 {x.knowledgeBaseId || '—'}
                  {x.documentId ? `，文档 ID ${x.documentId}` : ''}）{x.error ? `：${x.error}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

export function RunResultView({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const [itemType, setItemType] = useState('');
  const [filter, setFilter] = useState('');
  const [drill, setDrill] = useState<RagEvalResult | null>(null);

  const run = useQuery({
    queryKey: ['rag-eval', 'run', runId],
    queryFn: () => ragEvalApi.run(runId),
    refetchInterval: (q) =>
      q.state.data && ['PENDING', 'RUNNING'].includes(q.state.data.status) ? 5000 : false,
  });
  const results = useQuery({
    queryKey: ['rag-eval', 'run', runId, 'results', page, itemType, filter, run.data?.processed],
    queryFn: () =>
      ragEvalApi.results(runId, {
        page,
        pageSize: PAGE_SIZE,
        itemType: itemType || undefined,
        verdict: filter && filter !== 'review' ? filter : undefined,
        needsReview: filter === 'review' ? 'true' : undefined,
      }),
    enabled: !!run.data,
  });

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !drill) onClose(); };
    window.addEventListener('keydown', escape);
    return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', escape); };
  }, [onClose, drill]);

  if (run.isLoading || !run.data) return <LoadingBlock />;
  const r = run.data;
  const st = RAG_RUN_STATUS[r.status] ?? { label: r.status, tone: 'neutral' as const };

  return (
    <div className="fixed inset-0 z-40 !m-0 bg-slate-950/40">
      <button type="button" aria-label="关闭结果抽屉" className="absolute inset-0 h-full w-full" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label="评估结果" className="absolute inset-y-0 right-0 w-full max-w-6xl overflow-y-auto bg-canvas shadow-pop">
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>
          评估结果 · {r.modelTargetName} · {r.testSetName}
        </CardTitle>
        <div className="flex items-center gap-4">
          <Badge tone={st.tone}>{st.label}</Badge>
          <span className="text-sm text-slate-500">
            {r.processed}/{r.total}
          </span>
          <button type="button" className={linkButton} onClick={onClose}>
            关闭
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {r.error && <p className="text-sm text-severity-critical">{r.error}</p>}
        <RunPreconditions r={r} />
        {r.groups ? (
          <RunGroups groups={r.groups} />
        ) : (
          <p className="text-sm text-slate-500">运行尚未产生结果。</p>
        )}
        <section className="space-y-2" aria-label="逐题明细">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-900">
              逐题明细（点击查看上下文与引用）
            </h3>
            <div className="flex gap-2">
              <Select
                aria-label="按结论筛选"
                className="w-36"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">全部结论</option>
                <option value="FAIL">未通过</option>
                <option value="PASS">通过</option>
                <option value="UNKNOWN">无法判定/未评估</option>
                <option value="review">需人工复核</option>
              </Select>
              <Select
                aria-label="按题型筛选"
                className="w-40"
                value={itemType}
                onChange={(e) => {
                  setItemType(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">全部题型</option>
                {[...RAG_QUALITY_TYPES, ...RAG_SECURITY_TYPES].map((t) => (
                  <option key={t} value={t}>
                    {ragTypeLabel(t)}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {results.isLoading ? (
            <LoadingBlock />
          ) : (results.data?.items ?? []).length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">没有符合筛选条件的题目</p>
          ) : (
            <>
              <Table>
                <THead>
                  <TR>
                    <TH>题型</TH>
                    <TH>问题</TH>
                    <TH>结论</TH>
                    <TH>说明</TH>
                    <TH>操作</TH>
                  </TR>
                </THead>
                <TBody>
                  {(results.data?.items ?? []).map((x) => (
                    <TR key={x.id}>
                      <TD data-label="题型" className="whitespace-nowrap">
                        {ragTypeLabel(x.itemType)}
                      </TD>
                      <TD data-label="问题" className="max-w-[20rem]">
                        {x.question}
                      </TD>
                      <TD data-label="结论">
                        <VerdictBadge r={x} />
                      </TD>
                      <TD data-label="说明" className="max-w-[22rem] text-xs text-slate-500">
                        {x.reason ?? x.errorMessage ?? '—'}
                      </TD>
                      <TD data-label="操作">
                        <button type="button" className={linkButton} onClick={() => setDrill(x)}>
                          详情
                        </button>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <Pagination
                page={page}
                pageSize={PAGE_SIZE}
                total={results.data?.total ?? 0}
                onPageChange={setPage}
              />
            </>
          )}
        </section>
      </CardContent>
      {drill && <ResultDrill r={drill} onClose={() => setDrill(null)} />}
    </Card>
      </aside>
    </div>
  );
}
