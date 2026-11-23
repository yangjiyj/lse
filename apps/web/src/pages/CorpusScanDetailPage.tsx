import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  FINDING_CATEGORY_LABELS,
  JUDGE_VERDICT_LABELS,
  corpusScansApi,
  formatBytes,
  maskedFileName,
  scanFormatLabel,
  type FindingCategory,
} from '@/lib/corpus-scans';
import { formatDateTime, formatNumber } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard, NoteBar } from '@/components/page-kit/SectionCard';
import { SegmentTabs } from '@/components/page-kit/SegmentTabs';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { SeverityBadge, TaskStatusBadge } from '@/components/ui/status-badge';
import { LoadingBlock } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/lib/auth';

const PAGE_SIZE = 50;
type Tab = 'all' | FindingCategory;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="px-5 py-4">
      <div className="text-[13px] text-ink-3">{label}</div>
      <div className="mt-1 text-[22px] font-semibold tabular-nums text-ink">{value}</div>
    </Card>
  );
}

export function CorpusScanDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('all');
  const [page, setPage] = useState(1);
  const { error: toastError } = useToast();
  const { hasPermission } = useAuth();
  const canExport = hasPermission('corpus_scan:export');

  const scanQuery = useQuery({
    queryKey: ['corpus-scan', id],
    queryFn: () => corpusScansApi.get(id),
    refetchInterval: (q) =>
      q.state.data && ['PENDING', 'RUNNING'].includes(q.state.data.status) ? 3000 : false,
  });
  const scan = scanQuery.data;
  const done = scan?.status === 'COMPLETED';
  const category = tab === 'all' ? undefined : tab;
  const findings = useQuery({
    queryKey: ['corpus-scan-findings', id, tab, page],
    queryFn: () =>
      corpusScansApi.findings(id, { ...(category ? { category } : {}), page, pageSize: PAGE_SIZE }),
    enabled: done,
  });
  const download = useMutation({
    mutationFn: (kind: 'csv' | 'json' | 'masked') =>
      kind === 'masked'
        ? corpusScansApi.maskedCopy(id, maskedFileName(scan!.fileName))
        : corpusScansApi.exportFindings(id, kind),
    onError: (e: Error) => toastError(e.message),
  });

  if (scanQuery.isLoading) return <LoadingBlock />;
  if (scanQuery.error || !scan) {
    return (
      <p className="p-4 text-sm text-severity-critical">
        {(scanQuery.error as Error | null)?.message ?? '加载失败'}
      </p>
    );
  }
  const by = scan.stats?.byCategory ?? { violation: 0, sensitive: 0, custom: 0 };
  const tabs = [
    { value: 'all' as const, label: `全部 ${formatNumber(scan.findingCount)}` },
    ...(['violation', 'sensitive', 'custom'] as const).map((c) => ({
      value: c,
      label: `${FINDING_CATEGORY_LABELS[c]} ${formatNumber(by[c])}`,
    })),
  ];
  const progress =
    scan.bytes > 0 ? Math.min(100, Math.round((scan.progressBytes / scan.bytes) * 100)) : 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={scan.fileName}
        actions={
          done && canExport ? (
            <>
              <Button
                variant="outline"
                disabled={download.isPending}
                onClick={() => download.mutate('csv')}
              >
                导出 CSV
              </Button>
              <Button
                variant="outline"
                disabled={download.isPending}
                onClick={() => download.mutate('json')}
              >
                导出 JSON
              </Button>
              {scan.maskedCopyReady && (
                <Button
                  variant="outline"
                  disabled={download.isPending}
                  onClick={() => download.mutate('masked')}
                >
                  打码副本
                </Button>
              )}
            </>
          ) : undefined
        }
      />
      <Card className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3 text-[13.5px] text-ink-2">
        <TaskStatusBadge value={scan.status} />
        {scan.status === 'RUNNING' && <span>已处理 {progress}%</span>}
        <span>{scanFormatLabel(scan)}</span>
        <span>{formatBytes(scan.bytes)}</span>
        {scan.ruleSet && <span>规则集：{scan.ruleSet.name}</span>}
        {scan.filesPurgedAt && <span>原文件已清理</span>}
        <span>
          {scan.createdBy?.name ?? '—'} · {formatDateTime(scan.createdAt)}
        </span>
      </Card>
      {scan.status === 'FAILED' && (
        <NoteBar className="text-severity-critical">{scan.error ?? '扫描失败'}</NoteBar>
      )}

      {done && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="记录数" value={formatNumber(scan.totalRecords)} />
            <Stat label="非法记录" value={formatNumber(scan.invalidRecords)} />
            <Stat label="命中" value={formatNumber(scan.findingCount)} />
            <Stat label="违规内容" value={formatNumber(by.violation)} />
            <Stat label="敏感信息" value={formatNumber(by.sensitive)} />
            <Stat label="自定义规则" value={formatNumber(by.custom)} />
          </div>
          {scan.truncated && <NoteBar>命中过多，仅保存前 50000 条</NoteBar>}
          {(scan.stats?.cappedFindings ?? 0) > 0 && (
            <NoteBar>
              单条记录同类命中超过 1000 条的部分只计数：
              {formatNumber(scan.stats!.cappedFindings!)} 条
            </NoteBar>
          )}
          {(scan.stats?.disabledRules ?? []).map((r) => (
            <NoteBar key={r.ruleId}>规则「{r.pattern}」超时已停用</NoteBar>
          ))}
          {(scan.stats?.regexTruncatedFields ?? 0) > 0 && (
            <NoteBar>
              {formatNumber(scan.stats!.regexTruncatedFields!)} 个字段超过 10
              万字，自定义正则只检查了前 10 万字
            </NoteBar>
          )}
          {(scan.stats?.regexRulesIgnored ?? 0) > 0 && (
            <NoteBar>
              正则规则超过 500 条，{formatNumber(scan.stats!.regexRulesIgnored!)} 条没有参与
            </NoteBar>
          )}
          {scan.judgeNote && <NoteBar>{scan.judgeNote}</NoteBar>}

          {(scan.stats?.bySubtype.length ?? 0) > 0 && (
            <SectionCard title="命中分布" bodyClassName="p-0">
              <Table>
                <THead>
                  <TR>
                    <TH>类别</TH>
                    <TH>子类</TH>
                    <TH>命中数</TH>
                  </TR>
                </THead>
                <TBody>
                  {scan.stats!.bySubtype.map((b) => (
                    <TR key={`${b.category}:${b.subtype}`}>
                      <TD data-label="类别">{FINDING_CATEGORY_LABELS[b.category]}</TD>
                      <TD data-label="子类">
                        {b.category === 'violation' ? (
                          <>
                            <span className="font-mono">{b.subtype}</span> {b.label}
                          </>
                        ) : (
                          (b.label ?? b.subtype)
                        )}
                      </TD>
                      <TD data-label="命中数" className="tabular-nums">
                        {formatNumber(b.count)}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </SectionCard>
          )}

          <SectionCard
            title="命中明细"
            extra={
              <SegmentTabs
                ariaLabel="命中类别"
                size="sm"
                items={tabs}
                value={tab}
                onChange={(v) => {
                  setTab(v);
                  setPage(1);
                }}
              />
            }
            bodyClassName="p-0"
          >
            {findings.isLoading ? (
              <LoadingBlock />
            ) : (findings.data?.items.length ?? 0) === 0 ? (
              <EmptyState title="没有命中" />
            ) : (
              <div className="px-6 pb-4">
                <Table>
                  <THead>
                    <TR>
                      <TH>记录</TH>
                      <TH>字段</TH>
                      <TH>类别</TH>
                      <TH>命中内容</TH>
                      <TH>严重度</TH>
                      <TH>复核</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {findings.data!.items.map((f) => (
                      <TR key={f.id}>
                        <TD data-label="记录" className="whitespace-nowrap tabular-nums">
                          #{f.recordIndex}
                          <span className="ml-1 text-xs text-ink-3">第 {f.line} 行</span>
                        </TD>
                        <TD data-label="字段" className="font-mono text-xs">
                          {f.fieldPath}
                        </TD>
                        <TD data-label="类别" className="whitespace-nowrap">
                          {f.category === 'violation' ? (
                            <span title={f.subtypeLabel ?? undefined} className="font-mono">
                              {f.subtype}
                            </span>
                          ) : (
                            (f.subtypeLabel ?? f.subtype)
                          )}
                        </TD>
                        <TD data-label="命中内容" className="max-w-[520px] break-all text-[13px]">
                          <span className="text-ink-3">{f.contextBefore}</span>
                          <mark className="rounded bg-amber-100 px-0.5 text-ink">
                            {f.matchText}
                          </mark>
                          <span className="text-ink-3">{f.contextAfter}</span>
                        </TD>
                        <TD data-label="严重度">
                          <SeverityBadge value={f.severity} />
                        </TD>
                        <TD data-label="复核" className="text-[13px]">
                          {f.judgeVerdict ? (
                            <span title={f.judgeReason ?? undefined}>
                              {JUDGE_VERDICT_LABELS[f.judgeVerdict] ?? f.judgeVerdict}
                            </span>
                          ) : (
                            '—'
                          )}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
                <Pagination
                  page={page}
                  pageSize={PAGE_SIZE}
                  total={findings.data?.total ?? 0}
                  onPageChange={setPage}
                />
              </div>
            )}
          </SectionCard>

          {(scan.stats?.invalidSamples.length ?? 0) > 0 && (
            <SectionCard title="非法记录" bodyClassName="p-0">
              <Table>
                <THead>
                  <TR>
                    <TH>行号</TH>
                    <TH>原因</TH>
                  </TR>
                </THead>
                <TBody>
                  {scan.stats!.invalidSamples.map((s, i) => (
                    <TR key={`${s.line}-${i}`}>
                      <TD data-label="行号" className="tabular-nums">
                        {s.line}
                      </TD>
                      <TD data-label="原因">{s.reason}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </SectionCard>
          )}
        </>
      )}
    </div>
  );
}
