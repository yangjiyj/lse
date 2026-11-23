import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  BarChart3,
  Bot,
  CheckCircle2,
  ClipboardList,
  FileDown,
  FileText,
  Gauge,
  Info,
  PieChart,
  ShieldCheck,
  Target,
} from 'lucide-react';
import {
  api,
  ApiError,
  type Report,
  type ReportChartDatum,
  type RiskItemSeverityGroup,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/components/ui/toast';
import { presentReportConclusion } from '@/lib/report-conclusion';
import { PageHeader } from '@/components/PageHeader';
import { EndpointReportPreview } from '@/components/reports/EndpointReportPreview';
import { CombinedReportModal } from '@/components/reports/CombinedReportModal';
import { CombinedReportDetail } from '@/components/reports/CombinedReportDetail';
import { ReportTemplateSelect } from '@/components/reports/ReportTemplateSelect';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { ChipToggle } from '@/components/page-kit/ChipToggle';
import { NoteBox } from '@/components/page-kit/NoteBox';
import { FilterBar } from '@/components/page-kit/FilterBar';
import { TenantCell, TenantFilterSelect, useTenantView } from '@/lib/tenant-view';
import { Spinner } from '@/components/ui/spinner';
import { QueryState } from '@/components/QueryState';
import {
  REPORT_KINDS,
  REPORT_KIND_LABELS,
  formatDateTime,
  formatPercent,
  reportKindLabel,
  riskCategoryLabel,
  severityLabel,
  SEVERITY_LABELS,
  REPORT_SECTIONS,
  REPORT_SECTION_LABELS,
  REPORT_EXPORT_PROFILES,
  REPORT_EXPORT_PROFILE_META,
  evidenceStrengthLabel,
  executionOutcomeLabel,
  reviewStatusLabel,
  remediationStatusLabel,
  type ReportExportProfile,
  type ReportKind,
} from '@/lib/format';

// 风险等级筛选展示顺序：从高到低
const SEVERITY_FILTER_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;

/** 区分同标题多版本用的短时间戳：MM/DD HH:mm（本地时区）。 */
function shortStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const GBT_REPORT_KIND: ReportKind = 'gbt45654_content';
const COMBINED_REPORT_KIND: ReportKind = 'combined';

/** 国标报告不走通用结论快照：整体结论与报告等级来自摘要里的 metrics。 */
function gbtReportBadge(summary: { metrics?: Record<string, number | string | null> } | undefined) {
  const overall = summary?.metrics?.overallLabel;
  const grade = summary?.metrics?.gradeLabel;
  return {
    overall: typeof overall === 'string' && overall ? overall : '—',
    grade: typeof grade === 'string' && grade ? grade : null,
  };
}

export function ReportsPage() {
  const { hasPermission } = useAuth();
  const { isAllTenants, listParams, tenantFilter, guardRow } = useTenantView();
  const { error: toastError, success: toastSuccess } = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const taskId = searchParams.get('taskId') ?? undefined;
  const initialReportId = searchParams.get('reportId') ?? undefined;
  const initialKind = REPORT_KINDS.includes(searchParams.get('kind') as ReportKind)
    ? (searchParams.get('kind') as ReportKind)
    : '';
  const [page, setPage] = useState(1);
  const [kind, setKind] = useState<ReportKind | ''>(initialKind);
  const [viewId, setViewId] = useState<string | null>(initialReportId ?? null);
  const [detailSeverities, setDetailSeverities] = useState<string[]>([]);
  const [detailSections, setDetailSections] = useState<string[]>([...REPORT_SECTIONS]);
  const [detailProfile, setDetailProfile] = useState<ReportExportProfile>('full');
  // 用户在下载时改过导出范围或章节才把它们传给后端；没改时按生成时的章节、报告模板出。
  const [detailScopeTouched, setDetailScopeTouched] = useState(false);
  const [detailRiskDomains, setDetailRiskDomains] = useState<string[]>([]);
  // 下载时另选报告模板（2.4.7）；空表示按生成时的模板，没有则用本租户默认模板。
  const [detailTemplateId, setDetailTemplateId] = useState('');
  const [combinedOpen, setCombinedOpen] = useState(false);

  const canRead = hasPermission('report:read');
  const canDownload = hasPermission('report:download');
  const canDelete = hasPermission('report:generate');
  const canGenerate = hasPermission('report:generate');

  const listQuery = useQuery({
    queryKey: ['reports', taskId, kind, page, tenantFilter],
    queryFn: () =>
      api.reports.list({ taskId, kind: kind || undefined, page, pageSize: 10, ...listParams }),
    enabled: canRead,
  });

  // 国标专项报告独立存放在 standard_reports，这里只做索引与下载入口，
  // 指标与证据明细仍以「国标专项测评」页面为准。
  const standardRunsQuery = useQuery({
    queryKey: ['standard-runs', 'with-report'],
    queryFn: () => api.standardEvaluations.list({ pageSize: 20 }),
    enabled: hasPermission('standard_eval:read'),
  });
  const standardReported = (standardRunsQuery.data?.items ?? []).filter(
    (item) => item.reportCount > 0,
  );

  const reportQuery = useQuery({
    queryKey: ['report', viewId],
    queryFn: () => api.reports.get(viewId as string),
    enabled: !!viewId,
  });

  // Open the report passed via ?reportId once.
  useEffect(() => {
    if (initialReportId) setViewId(initialReportId);
  }, [initialReportId]);

  // 切换查看的报告时重置筛选（等级全量、章节全选）。
  useEffect(() => {
    setDetailSeverities([]);
    setDetailSections([...REPORT_SECTIONS]);
    setDetailProfile('full');
    setDetailScopeTouched(false);
    setDetailRiskDomains([]);
  }, [viewId]);

  function toggleDetailSeverity(s: string) {
    setDetailSeverities((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }
  function toggleDetailSection(s: string) {
    setDetailScopeTouched(true);
    setDetailSections((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }
  function toggleDetailRiskDomain(domain: string) {
    setDetailRiskDomains((prev) =>
      prev.includes(domain) ? prev.filter((item) => item !== domain) : [...prev, domain],
    );
  }
  function selectDetailProfile(profile: ReportExportProfile) {
    setDetailScopeTouched(true);
    setDetailProfile(profile);
    setDetailSections([...REPORT_EXPORT_PROFILE_META[profile].sections]);
  }

  const downloadMutation = useMutation({
    mutationFn: ({
      id,
      profile,
      severity,
      riskDomain,
      sections,
      templateId,
      format,
    }: {
      id: string;
      profile?: ReportExportProfile;
      severity?: string[];
      riskDomain?: string[];
      sections?: string[];
      templateId?: string;
      format: 'pdf' | 'html' | 'docx';
    }) =>
      // 没给的不传：没改导出范围和章节时后端按生成时的章节、报告模板出。
      api.reports.download(
        id,
        Object.fromEntries(
          Object.entries({ profile, severity, riskDomain, sections, templateId }).filter(
            ([, v]) => v !== undefined,
          ),
        ),
        format,
      ),
    onError: (e) => toastError(e instanceof ApiError ? e.message : '下载失败'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.reports.remove(id),
    onSuccess: () => {
      toastSuccess('报告已删除');
      void queryClient.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (e) => toastError(e instanceof ApiError ? e.message : '删除失败'),
  });

  const items = listQuery.data?.items ?? [];
  const total = listQuery.data?.total ?? 0;

  function clearTaskFilter() {
    const next = new URLSearchParams(searchParams);
    next.delete('taskId');
    setSearchParams(next, { replace: true });
    setPage(1);
  }

  function changeKind(value: string) {
    const nextKind = value as ReportKind | '';
    setKind(nextKind);
    setPage(1);
    const next = new URLSearchParams(searchParams);
    if (nextKind) next.set('kind', nextKind);
    else next.delete('kind');
    setSearchParams(next, { replace: true });
  }

  return (
    <div className="space-y-6">
      <PageHeader title="报告管理" description="正式评估报告与历史版本" />

      {standardReported.length > 0 && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-[15px] font-bold text-ink">国标专项报告</h2>
                <p className="text-xs text-ink-3">
                  依据 GB/T 45654-2025 参考方法生成的对标报告，单独留存证据附件。
                </p>
              </div>
              <Link
                to="/eval-tasks"
                className="text-[13px] font-medium text-brand-700 hover:underline"
              >
                前往评估任务
              </Link>
            </div>
            <Table>
              <THead>
                <TR>
                  <TH>名称</TH>
                  <TH>模型 API</TH>
                  <TH>版本数</TH>
                  <TH>生成时间</TH>
                  <TH className="text-right">操作</TH>
                </TR>
              </THead>
              <TBody>
                {standardReported.map((item) => (
                  <TR key={item.runId}>
                    <TD data-label="名称">
                      <Link
                        to={`/eval-tasks/${item.taskId}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {item.name}
                      </Link>
                    </TD>
                    <TD data-label="模型 API">{item.modelTargetName ?? '—'}</TD>
                    <TD data-label="版本数">{item.reportCount}</TD>
                    <TD data-label="生成时间">{formatDateTime(item.createdAt)}</TD>
                    <TD data-label="操作" className="text-right">
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!canDownload}
                          onClick={() => api.standardEvaluations.downloadReportPdf(item.runId)}
                        >
                          <FileDown className="mr-1 h-4 w-4" />
                          PDF
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!canDownload}
                          onClick={() => api.standardEvaluations.downloadEvidence(item.runId)}
                        >
                          <FileDown className="mr-1 h-4 w-4" />
                          证据
                        </Button>
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <FilterBar className="mb-0 justify-between">
        {taskId ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>正在按任务筛选报告。</span>
            <Button variant="ghost" size="sm" onClick={clearTaskFilter}>
              查看全部报告
            </Button>
          </div>
        ) : (
          <span className="text-[13px] text-ink-3">共 {total} 份报告</span>
        )}
        <div className="flex items-center gap-2">
          <TenantFilterSelect />
          <label htmlFor="report-kind-filter" className="text-sm text-muted-foreground">
            报告类型
          </label>
          <Select
            id="report-kind-filter"
            value={kind}
            onChange={(e) => changeKind(e.target.value)}
            className="w-[220px] max-w-full"
          >
            <option value="">全部类型</option>
            {REPORT_KINDS.map((item) => (
              <option key={item} value={item}>
                {REPORT_KIND_LABELS[item]}
              </option>
            ))}
          </Select>
          {canGenerate && !isAllTenants ? (
            <Button variant="outline" onClick={() => setCombinedOpen(true)}>
              组合报告
            </Button>
          ) : null}
        </div>
      </FilterBar>

      {items.some(
        (r) =>
          r.kind !== GBT_REPORT_KIND &&
          r.kind !== COMBINED_REPORT_KIND &&
          !presentReportConclusion(r.summary?.conclusionSnapshot).downloadable,
      ) ? (
        <NoteBox tone="warning" className="flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            列表中的部分历史报告缺少统一评估结论快照，仅供内部追溯，不建议直接对外交付。如需对外使用，请在对应任务中「重新生成正式报告」。
          </span>
        </NoteBox>
      ) : null}

      <Card>
        <CardContent className="p-0">
          <QueryState
            isLoading={listQuery.isLoading}
            isError={listQuery.isError}
            error={listQuery.error}
            onRetry={() => void listQuery.refetch()}
            empty={items.length === 0}
            filtered={Boolean(taskId || kind)}
            permissionDenied={!canRead}
            emptyTitle="暂无报告"
            emptyDescription="完成评估任务后，可在任务详情页生成中文评估报告。"
            emptyIcon={<FileText className="h-6 w-6" />}
          />
          {!listQuery.isLoading && !listQuery.isError && canRead && items.length > 0 ? (
            <>
              <Table>
                <THead>
                  <TR>
                    {isAllTenants && <TH>租户</TH>}
                    <TH>报告标题</TH>
                    <TH>类型</TH>
                    <TH>
                      <span title="本次评估使用的测试样本数量">测试样本</span>
                    </TH>
                    <TH>评估结论</TH>
                    <TH>
                      <span title="仅统计有效判定，不等同于上线或合规结论">有效判定通过率</span>
                    </TH>
                    <TH>
                      <span title="经判定有效的风险项数量">有效风险项</span>
                    </TH>
                    <TH>生成时间</TH>
                    <TH className="text-right">操作</TH>
                  </TR>
                </THead>
                <TBody>
                  {items.map((r) => {
                    const isGbt = r.kind === GBT_REPORT_KIND;
                    const isCombined = r.kind === COMBINED_REPORT_KIND;
                    const gbtBadge = gbtReportBadge(r.summary);
                    const conclusion =
                      isGbt || isCombined
                        ? { ...presentReportConclusion(undefined), downloadable: true }
                        : presentReportConclusion(r.summary?.conclusionSnapshot);
                    // 同一页内标题相同的多份报告：标题后追加生成时间，避免只能靠“生成时间”列分辨。
                    const duplicated = items.filter((x) => x.title === r.title).length > 1;
                    const stamp = duplicated ? shortStamp(r.createdAt) : '';
                    const shownTitle = stamp ? `${r.title}（生成于 ${stamp}）` : r.title;
                    return (
                      <TR key={r.id}>
                        {isAllTenants && (
                          <TD data-label="租户">
                            <TenantCell tenantId={r.tenantId} />
                          </TD>
                        )}
                        <TD data-label="报告标题" className="max-w-[420px] py-3">
                          <div
                            className="break-words text-[13.5px] font-semibold leading-5 text-ink"
                            title={shownTitle}
                          >
                            {shownTitle}
                          </div>
                        </TD>
                        <TD data-label="类型">
                          <Badge tone="info">
                            {isCombined
                              ? (r.label ?? `组合 · ${r.taskCount ?? 0} 个任务`)
                              : reportKindLabel(r.kind)}
                          </Badge>
                        </TD>
                        <TD data-label="测试样本" className="tabular-nums">
                          {r.totalQuestions}
                        </TD>
                        <TD data-label="评估结论">
                          {isGbt ? (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge tone="info">{gbtBadge.overall}</Badge>
                              {gbtBadge.grade ? (
                                <Badge tone="neutral">{gbtBadge.grade}</Badge>
                              ) : null}
                            </div>
                          ) : isCombined ? (
                            <Badge tone={(r.summary?.findingCount ?? 0) > 0 ? 'danger' : 'success'}>
                              {(r.summary?.findingCount ?? 0) > 0 ? '发现风险' : '未发现风险'}
                            </Badge>
                          ) : (
                            <Badge tone={conclusion.tone} icon>
                              {conclusion.title}
                            </Badge>
                          )}
                        </TD>
                        <TD data-label="通过率" className="tabular-nums">
                          {conclusion.passRate == null ? '—' : formatPercent(conclusion.passRate)}
                        </TD>
                        <TD data-label="有效风险项" className="tabular-nums">
                          {isGbt || r.summary?.findingCount == null ? (
                            '—'
                          ) : (
                            <span
                              className={
                                r.summary.findingCount > 0
                                  ? 'font-semibold text-severity-high'
                                  : 'text-ink-2'
                              }
                            >
                              {r.summary.findingCount}
                            </span>
                          )}
                        </TD>
                        <TD data-label="生成时间" className="whitespace-nowrap text-xs text-ink-3">
                          {formatDateTime(r.createdAt)}
                        </TD>
                        <TD
                          data-label="操作"
                          className="text-right"
                          onClickCapture={
                            isAllTenants
                              ? (e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  guardRow(r.tenantId, '/reports');
                                }
                              : undefined
                          }
                        >
                          <div className="flex flex-nowrap justify-start gap-0.5 md:justify-end">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-brand-700 hover:text-brand-700"
                              onClick={() => setViewId(r.id)}
                            >
                              查看
                            </Button>
                            {canDownload && conclusion.downloadable ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setViewId(r.id)}
                                disabled={downloadMutation.isPending}
                              >
                                导出
                              </Button>
                            ) : !conclusion.downloadable ? (
                              <Link
                                to={`/eval-tasks/${r.taskId}`}
                                className="inline-flex h-7 items-center justify-center whitespace-nowrap rounded px-2.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
                                title="历史报告缺少统一结论快照，仅供追溯；点此前往任务重新生成正式报告"
                              >
                                重新生成
                              </Link>
                            ) : null}
                            {canDelete ? (
                              <Button
                                variant="ghost"
                                className="text-severity-critical hover:text-severity-critical"
                                size="sm"
                                onClick={() => {
                                  if (
                                    window.confirm(`确认删除报告「${r.title}」？此操作不可撤销。`)
                                  ) {
                                    deleteMutation.mutate(r.id);
                                  }
                                }}
                                disabled={deleteMutation.isPending}
                              >
                                删除
                              </Button>
                            ) : null}
                          </div>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
              <div className="border-t border-border p-3">
                <Pagination page={page} pageSize={10} total={total} onPageChange={setPage} />
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      <Modal
        open={!!viewId}
        onClose={() => {
          setViewId(null);
          setDetailTemplateId('');
        }}
        title={reportQuery.data?.title ?? '评估报告'}
        description={
          reportQuery.data
            ? reportQuery.data.kind === COMBINED_REPORT_KIND
              ? `生成于 ${formatDateTime(reportQuery.data.createdAt)} · 组合 · ${reportQuery.data.tasks?.length ?? 0} 个任务`
              : reportQuery.data.kind === GBT_REPORT_KIND
                ? `生成于 ${formatDateTime(reportQuery.data.createdAt)} · ${gbtReportBadge(reportQuery.data.summary).overall}`
                : `生成于 ${formatDateTime(reportQuery.data.createdAt)} · ${presentReportConclusion(reportQuery.data.summary.conclusionSnapshot).title}`
            : undefined
        }
        size="xl"
        footer={
          reportQuery.data && canDownload
            ? (() => {
                const data = reportQuery.data;
                // 国标报告、组合报告没有交付模板和筛选，按报告原样下载。
                const fixedLayout =
                  data.kind === GBT_REPORT_KIND || data.kind === COMBINED_REPORT_KIND;
                // 国标报告有自己的版式，不套报告模板。
                const templatable = data.kind !== GBT_REPORT_KIND;
                const download = (format: 'pdf' | 'html' | 'docx') =>
                  downloadMutation.mutate({
                    id: data.id,
                    format,
                    ...(templatable && detailTemplateId ? { templateId: detailTemplateId } : {}),
                    ...(fixedLayout
                      ? {}
                      : {
                          severity: detailSeverities,
                          riskDomain: detailRiskDomains,
                          ...(detailScopeTouched
                            ? { profile: detailProfile, sections: detailSections }
                            : {}),
                        }),
                  });
                const disabled =
                  downloadMutation.isPending ||
                  (!fixedLayout &&
                    (detailSections.length === 0 ||
                      !presentReportConclusion(data.summary.conclusionSnapshot).downloadable));
                return (
                  <>
                    {templatable && (
                      <ReportTemplateSelect
                        value={detailTemplateId}
                        onChange={setDetailTemplateId}
                        emptyLabel="按生成时"
                        tenantId={isAllTenants ? data.tenantId : undefined}
                        className="mr-auto"
                      />
                    )}
                    <Button variant="outline" onClick={() => download('html')} disabled={disabled}>
                      下载 HTML
                    </Button>
                    {/* 国标报告、终端报告不出 Word */}
                    {data.kind !== GBT_REPORT_KIND && !data.summary?.endpointSummary ? (
                      <Button
                        variant="outline"
                        onClick={() => download('docx')}
                        disabled={disabled}
                      >
                        下载 Word
                      </Button>
                    ) : null}
                    <Button onClick={() => download('pdf')} disabled={disabled}>
                      <FileDown className="mr-1 h-4 w-4" />
                      生成并下载 PDF
                    </Button>
                  </>
                );
              })()
            : null
        }
      >
        {reportQuery.isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : reportQuery.data?.kind === COMBINED_REPORT_KIND ? (
          <CombinedReportDetail report={reportQuery.data} />
        ) : reportQuery.data?.kind === GBT_REPORT_KIND ? (
          <iframe
            title="国标评估报告"
            sandbox=""
            srcDoc={reportQuery.data.content}
            className="h-[70vh] w-full rounded-md border border-line bg-white"
          />
        ) : reportQuery.data ? (
          <ReportDetailView
            report={reportQuery.data}
            profile={detailProfile}
            onSelectProfile={selectDetailProfile}
            severities={detailSeverities}
            onToggleSeverity={toggleDetailSeverity}
            riskDomains={detailRiskDomains}
            onToggleRiskDomain={toggleDetailRiskDomain}
            sections={detailSections}
            onToggleSection={toggleDetailSection}
          />
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">无法加载报告内容。</p>
        )}
      </Modal>

      <CombinedReportModal
        open={combinedOpen}
        onClose={() => setCombinedOpen(false)}
        onCreated={(created) => {
          setCombinedOpen(false);
          setViewId(created.id);
        }}
      />
    </div>
  );
}

type AssessmentTone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

interface ReportAssessment {
  level: string;
  recommendation: string;
  tone: AssessmentTone;
  summary: string;
}

function assessReport(report: Report): ReportAssessment {
  const conclusion = presentReportConclusion(report.summary.conclusionSnapshot);
  return {
    level: conclusion.title,
    recommendation: conclusion.coverageDetail,
    tone: conclusion.tone,
    summary: conclusion.detail,
  };
}

function toneClasses(tone: AssessmentTone): string {
  switch (tone) {
    case 'success':
      return 'border-severity-pass/20 bg-severity-pass-bg text-severity-pass';
    case 'warning':
      return 'border-severity-medium/20 bg-severity-medium-bg text-severity-medium';
    case 'danger':
      return 'border-severity-critical/20 bg-severity-critical-bg text-severity-critical';
    case 'info':
      return 'border-severity-low/20 bg-severity-low-bg text-severity-low';
    default:
      return 'border-line bg-[#F7F9FD] text-ink';
  }
}

function distributionToBars(
  distribution?: Record<string, number>,
  labeler?: (key: string) => string,
): ReportChartDatum[] {
  return Object.entries(distribution ?? {})
    .filter(([, value]) => value > 0)
    .map(([key, value]) => ({ key, label: labeler ? labeler(key) : key, value }))
    .sort((a, b) => b.value - a.value);
}

function firstAvailableBars(
  preferred: ReportChartDatum[] | undefined,
  fallback?: Record<string, number>,
  labeler?: (key: string) => string,
): ReportChartDatum[] {
  const bars = preferred?.filter((item) => item.value > 0) ?? [];
  return bars.length > 0 ? bars : distributionToBars(fallback, labeler);
}

function passRatePercentValue(report: Report): number | null {
  const passRate = presentReportConclusion(report.summary.conclusionSnapshot).passRate;
  return passRate == null ? null : Math.round(passRate * 1000) / 10;
}

function clampPercent(value: number | null): number {
  if (value === null || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function formatCount(value: number): string {
  return Number.isFinite(value) ? String(value) : '0';
}

function explanationTone(report: Report): AssessmentTone {
  const run = report.summary.explanationRun;
  if (!run || run.mode === 'local') return 'neutral';
  if (run.llmCount > 0 && run.fallbackCount === 0) return 'success';
  if (run.llmCount > 0) return 'warning';
  return 'danger';
}

function explanationStatusText(report: Report): string {
  const run = report.summary.explanationRun;
  if (!run) return '未记录模型分析';
  if (run.mode === 'local') return '本次未执行模型复核，风险说明由规则生成';
  if (run.llmCount > 0 && run.fallbackCount === 0) return '模型分析已完成';
  if (run.llmCount > 0) return '部分样本使用模型分析';
  return '本次未执行模型复核，风险说明由规则生成';
}

function explanationRunLabel(report: Report): string {
  const run = report.summary.explanationRun;
  if (!run) return '未记录';
  if (run.mode === 'self' || run.label.includes('被测模型')) return '评估对象辅助分析';
  if (run.mode === 'review_model') return '独立模型复核分析';
  return '规则依据分析';
}

function ReportVisualOverview({
  report,
  assessment,
  riskDomainBars,
  severityBars,
  categoryBars,
}: {
  report: Report;
  assessment: ReportAssessment;
  riskDomainBars: ReportChartDatum[];
  severityBars: ReportChartDatum[];
  categoryBars: ReportChartDatum[];
}) {
  const summary = report.summary;
  const passRate = passRatePercentValue(report);
  const passRateClamped = clampPercent(passRate);
  const processed = Math.max(1, summary.processedQuestions || summary.totalQuestions || 1);
  const passedPct = (summary.passedCount / processed) * 100;
  const failedPct = (summary.failedCount / processed) * 100;
  const errorPct = (summary.errorCount / processed) * 100;
  const topRisk = riskDomainBars[0]?.label ?? categoryBars[0]?.label ?? '暂无已确认风险';

  return (
    <section className="mb-4 rounded-md border border-border bg-slate-50 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-base font-semibold">
          <Gauge className="h-5 w-5 text-primary" />
          可视化总览
        </div>
        <Badge
          tone={
            assessment.tone === 'danger'
              ? 'danger'
              : assessment.tone === 'warning'
                ? 'warning'
                : assessment.tone === 'info'
                  ? 'info'
                  : 'neutral'
          }
        >
          {assessment.level}
        </Badge>
      </div>

      <div className="grid gap-4 xl:grid-cols-[280px_1fr]">
        <div className="rounded-md border border-border bg-white p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Gauge className="h-4 w-4" />
            有效判定通过率
          </div>
          <div className="flex items-center justify-center">
            <div
              className="relative flex h-36 w-36 items-center justify-center rounded-full"
              style={{
                background: `conic-gradient(#2563eb ${passRateClamped}%, #fee2e2 ${passRateClamped}% 100%)`,
              }}
            >
              <div className="flex h-24 w-24 flex-col items-center justify-center rounded-full bg-white shadow-inner">
                <span className="text-2xl font-semibold text-slate-950">
                  {passRate === null ? '—' : `${passRate.toFixed(1)}%`}
                </span>
                <span className="text-xs text-muted-foreground">仅统计有效判定样本</span>
              </div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
            <div
              className="rounded-md bg-emerald-50 px-2 py-2 text-emerald-700"
              title="评估对象按预期拒绝高风险请求"
            >
              <div className="font-semibold tabular-nums">{summary.passedCount}</div>
              <div>通过</div>
              <div className="mt-0.5 text-[10px] leading-tight opacity-80">符合预期安全行为</div>
            </div>
            <div
              className="rounded-md bg-red-50 px-2 py-2 text-red-700"
              title="最终判定为未通过的样本"
            >
              <div className="font-semibold tabular-nums">{summary.failedCount}</div>
              <div>未通过</div>
              <div className="mt-0.5 text-[10px] leading-tight opacity-80">需结合风险证据复核</div>
            </div>
            <div
              className="rounded-md bg-amber-50 px-2 py-2 text-amber-700"
              title="因调用失败或超时未完成有效判定"
            >
              <div className="font-semibold tabular-nums">{summary.errorCount}</div>
              <div>异常</div>
              <div className="mt-0.5 text-[10px] leading-tight opacity-80">未完成有效判定</div>
            </div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-md border border-border bg-white p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Target className="h-4 w-4" />
              评估结果构成
            </div>
            <div className="mb-3 h-3 overflow-hidden rounded-full bg-slate-100">
              <div className="flex h-full w-full">
                <div className="bg-emerald-500" style={{ width: `${Math.max(0, passedPct)}%` }} />
                <div className="bg-red-500" style={{ width: `${Math.max(0, failedPct)}%` }} />
                <div className="bg-amber-400" style={{ width: `${Math.max(0, errorPct)}%` }} />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
              <span title="当前启用规则未产生有效风险">
                通过 {formatCount(summary.passedCount)}
              </span>
              <span title="最终判定为未通过，需结合风险证据复核">
                未通过 {formatCount(summary.failedCount)}
              </span>
              <span title="因调用失败或超时未完成有效判定">
                执行异常 {formatCount(summary.errorCount)}
              </span>
            </div>
            <div className="mt-4 rounded-md border border-dashed border-border bg-muted/20 px-3 py-2 text-sm leading-6 text-muted-foreground">
              当前主要风险面：<span className="font-medium text-slate-900">{topRisk}</span>
            </div>
          </div>

          <div className="rounded-md border border-border bg-white p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <PieChart className="h-4 w-4" />
              风险域分布
            </div>
            <ReportBarList
              title="重点风险类型"
              bars={riskDomainBars.slice(0, 4)}
              empty="暂无风险域数据"
            />
          </div>

          <div className="rounded-md border border-border bg-white p-4 lg:col-span-2">
            <div className="grid gap-3 md:grid-cols-3">
              <ReportMiniBar title="严重等级" bars={severityBars.slice(0, 3)} />
              <ReportMiniBar title="风险类别" bars={categoryBars.slice(0, 3)} />
              <div className="rounded-xl border border-line bg-[#F7F9FD] p-3">
                <div className="text-xs text-muted-foreground">总体结论</div>
                <div className="mt-1 text-lg font-semibold text-slate-950">
                  {assessment.recommendation}
                </div>
                <div className="mt-2 text-xs leading-5 text-muted-foreground">
                  结论由报告冻结快照给出；通过率和风险分布仅用于解释证据，不替代结论。
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ReportComprehensiveModuleCoverage({ report }: { report: Report }) {
  const modules = report.summary.comprehensiveModules;
  if (!modules || modules.length === 0) return null;

  return (
    <section className="mb-4 rounded-2xl border border-line bg-white p-5 shadow-card">
      <div className="mb-3 flex items-center gap-2 text-base font-semibold">
        <ClipboardList className="h-5 w-5 text-primary" />
        综合评估模块覆盖
      </div>
      <p className="mb-3 text-sm leading-6 text-muted-foreground">
        以下模块来自同一个评估任务，样本按任务 seed 随机混排执行，统计按模块重新归集。
      </p>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {modules.map((module) => (
          <div key={module.id} className="rounded-xl border border-line bg-[#F7F9FD] p-3">
            <div className="font-medium text-slate-950">{module.label}</div>
            <div className="mt-2 grid grid-cols-5 gap-1 text-center text-xs">
              <div>
                <div className="font-semibold tabular-nums">{module.sampleCount}</div>
                <div className="text-muted-foreground">样本</div>
              </div>
              <div>
                <div className="font-semibold tabular-nums">{module.processedCount}</div>
                <div className="text-muted-foreground">已处理</div>
              </div>
              <div className="text-emerald-700">
                <div className="font-semibold tabular-nums">{module.passedCount}</div>
                <div>通过</div>
              </div>
              <div className="text-red-700">
                <div className="font-semibold tabular-nums">{module.failedCount}</div>
                <div>风险</div>
              </div>
              <div className="text-amber-700">
                <div className="font-semibold tabular-nums">{module.errorCount}</div>
                <div>异常</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ReportMiniBar({ title, bars }: { title: string; bars: ReportChartDatum[] }) {
  const max = Math.max(1, ...bars.map((bar) => bar.value));
  return (
    <div className="rounded-xl border border-line bg-[#F7F9FD] p-3">
      <div className="text-xs text-muted-foreground">{title}</div>
      <div className="mt-2 space-y-2">
        {bars.length > 0 ? (
          bars.map((bar) => (
            <div key={`${title}-${bar.key}`}>
              <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                <span className="truncate text-slate-700">{bar.label}</span>
                <span className="tabular-nums text-muted-foreground">{bar.value}</span>
              </div>
              <div className="h-1.5 rounded-full bg-white">
                <div
                  className="h-1.5 rounded-full bg-primary"
                  style={{ width: `${Math.max(8, (bar.value / max) * 100)}%` }}
                />
              </div>
            </div>
          ))
        ) : (
          <div className="text-xs text-muted-foreground">暂无数据</div>
        )}
      </div>
    </div>
  );
}

function ReportExplanationStatus({ report }: { report: Report }) {
  const run = report.summary.explanationRun;
  if (!run) return null;
  const samples = report.summary.wrongAnswerSamples ?? [];
  const tone = explanationTone(report);
  const reasons = run.skippedReasons ?? [];

  return (
    <section className="mb-4 rounded-2xl border border-line bg-white p-5 shadow-card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-base font-semibold">
          <Bot className="h-5 w-5 text-primary" />
          风险说明来源
        </div>
        <Badge tone={tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : 'neutral'}>
          {explanationStatusText(report)}
        </Badge>
      </div>
      <div className="grid gap-3 text-sm md:grid-cols-4">
        <div className="rounded-xl border border-line bg-[#F7F9FD] p-3">
          <div className="text-xs text-muted-foreground">说明来源</div>
          <div className="mt-1 font-medium">{explanationRunLabel(report)}</div>
        </div>
        <div className="rounded-xl border border-line bg-[#F7F9FD] p-3">
          <div className="text-xs text-muted-foreground">复核模型</div>
          <div className="mt-1 truncate font-medium">{run.modelTargetName ?? '未配置'}</div>
        </div>
        <div className="rounded-xl border border-line bg-[#F7F9FD] p-3">
          <div className="text-xs text-muted-foreground">模型复核数量</div>
          <div className="mt-1 font-medium tabular-nums">{run.llmCount} 条</div>
        </div>
        <div className="rounded-xl border border-line bg-[#F7F9FD] p-3">
          <div className="text-xs text-muted-foreground">规则说明数量</div>
          <div className="mt-1 font-medium tabular-nums">
            {run.fallbackCount} 条由规则生成说明，未执行模型复核
          </div>
        </div>
      </div>
      {reasons.length > 0 ? (
        <div className={`mt-3 rounded-md border px-3 py-2 text-sm leading-6 ${toneClasses(tone)}`}>
          {run.llmCount === 0
            ? '本次未执行模型复核，风险说明由规则生成。'
            : '部分样本未完成模型复核。'}
          原因：{reasons.join('；')}
        </div>
      ) : null}
      {samples.length > 0 ? (
        <div className="mt-3 space-y-2">
          <div className="text-sm font-medium text-muted-foreground">风险说明示例</div>
          {samples.slice(0, 3).map((sample, index) => (
            <div
              key={`${sample.questionContent}-${index}`}
              className="rounded-xl border border-line bg-[#F7F9FD] p-3"
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={sample.severityLabel.includes('高') ? 'danger' : 'warning'}>
                  {sample.severityLabel}
                </Badge>
                <span className="font-medium">{sample.riskTypeLabel}</span>
                <span className="text-xs text-muted-foreground">{sample.ruleActionLabel}</span>
              </div>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {sample.riskExplanation}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ReportEvidenceChain({ report }: { report: Report }) {
  const groups = report.summary.riskEvidencePortfolio?.activeRisks ?? [];
  if (groups.length === 0) return null;
  return (
    <section className="mb-4 rounded-2xl border border-line bg-white p-5 shadow-card">
      <div className="mb-1 flex items-center gap-2 text-base font-semibold">
        <ShieldCheck className="h-5 w-5 text-primary" />
        风险证据链
      </div>
      <p className="mb-3 text-xs leading-5 text-muted-foreground">
        口径：按本报告冻结的有效风险归并；严重性、证据强度、执行结果和人工复核互不替代。
      </p>
      <div className="space-y-3">
        {groups.map((group, index) => {
          const item = group.representative;
          return (
            <div
              key={`${item.riskCategory}-${index}`}
              className="rounded-xl border border-line bg-[#F7F9FD] p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={item.severity === 'CRITICAL' ? 'critical' : 'danger'}>
                  {item.severityLabel}
                </Badge>
                <span className="font-medium">{item.riskCategoryLabel}</span>
                <Badge tone="neutral">{item.verdictLabel}</Badge>
                <Badge tone="info">证据：{evidenceStrengthLabel(item.evidenceStrength)}</Badge>
                <Badge tone="neutral">执行：{executionOutcomeLabel(item.executionOutcome)}</Badge>
                <span className="text-xs text-muted-foreground">
                  复核：{reviewStatusLabel(item.reviewStatus)}
                </span>
              </div>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                {item.evidence ?? item.title ?? '未记录证据摘要'}
              </p>
              {group.evidence.length > 1 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  已归并 {group.evidence.length} 条引擎证据；查看原始样本可核验完整链路。
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function buildNextSteps(report: Report): Array<{ title: string; detail: string }> {
  const items = report.summary.remediationItems ?? [];
  const conclusion = presentReportConclusion(report.summary.conclusionSnapshot);
  const hasP0 = items.some((item) => item.priority === 'P0');
  const hasRisk = conclusion.title === '本次评估发现有效风险';
  const steps: Array<{ title: string; detail: string }> = [];

  if (conclusion.title === '评估结论不完整') {
    steps.push({
      title: '先补齐执行覆盖',
      detail: '排查未完成、异常或未知判定的样本与引擎，补齐同一评估范围后重新生成结论。',
    });
  }

  if (hasP0) {
    steps.push({
      title: '处置最高优先级风险',
      detail: '完成最高优先级风险整改后，使用相同样本和配置复测，并核对风险证据是否消除。',
    });
  }

  if (hasRisk) {
    steps.push({
      title: '扩展对抗样本覆盖',
      detail: '补充同义改写、多语言和编码变体样本，验证相邻攻击路径是否得到控制。',
    });
    steps.push({
      title: '核查 AI 防护配置',
      detail: '核查回答策略、敏感内容过滤、工具权限和输出脱敏配置，并记录配置变更。',
    });
  } else if (conclusion.title === '本次评估范围内未观察到有效风险') {
    steps.push({
      title: '周期性回归',
      detail: '保留本报告作为变更基线；每次模型、提示词或工具链变更后重新评估。',
    });
  }

  steps.push({
    title: '整理整改与变更材料',
    detail: '归档报告、风险证据、整改记录和复测结果，由安全与业务负责人按既定流程决策。',
  });

  return steps;
}

function severityTone(s: string): 'critical' | 'danger' | 'warning' | 'info' | 'neutral' {
  if (s === 'CRITICAL') return 'critical';
  if (s === 'HIGH') return 'danger';
  if (s === 'MEDIUM') return 'warning';
  if (s === 'LOW') return 'info';
  return 'neutral';
}

function complianceLine(c: { gbt45654: string[]; owasp: string[] }): string {
  const parts: string[] = [];
  if (c.gbt45654.length)
    parts.push(`GB/T 45654 条款关联线索（待专家复核，非合规认证）：${c.gbt45654.join('、')}`);
  if (c.owasp.length) parts.push(`OWASP LLM：${c.owasp.join('、')}`);
  return parts.length ? parts.join('　·　') : '—';
}

function RiskItemRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2">
      <span className="text-xs font-medium text-ink-3">{k}</span>
      <span className="whitespace-pre-wrap break-words">{v}</span>
    </div>
  );
}

function RiskItemsDetail({
  groups,
  severities,
}: {
  groups: RiskItemSeverityGroup[];
  severities: string[];
}) {
  const filtered =
    severities.length === 0
      ? groups
      : groups.filter((g) => g.severity !== 'UNSPECIFIED' && severities.includes(g.severity));
  if (filtered.length === 0) {
    return <p className="text-sm text-muted-foreground">无符合所选等级的风险项。</p>;
  }
  return (
    <div className="space-y-4">
      {filtered.map((g) => (
        <div key={g.severity}>
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Badge tone={severityTone(g.severity)} icon>
              {g.severityLabel}
            </Badge>
            <span className="text-muted-foreground">
              共 {g.items.length} 项
              {g.truncated > 0
                ? `（完整 ${g.items.length + g.truncated} 项已收录在导出的 PDF 附录中，点右下角「下载报告（PDF）」查看）`
                : ''}
            </span>
          </div>
          <div className="space-y-3">
            {g.items.map((it) => (
              <div key={it.seq} className="rounded-xl border border-line bg-[#F7F9FD] p-3 text-sm">
                <div className="mb-2 flex items-center gap-2 font-semibold text-ink">
                  <span className="rounded-md bg-white px-1.5 text-xs font-medium text-ink-3 ring-1 ring-inset ring-line">
                    #{it.seq}
                  </span>
                  <span>{it.riskCategoryLabel}</span>
                </div>
                <div className="space-y-1.5">
                  <RiskItemRow k="触发风险的提问" v={it.questionContent} />
                  <RiskItemRow k="评估对象响应" v={it.evidence} />
                  <RiskItemRow k="风险说明" v={it.riskExplanation} />
                  <RiskItemRow k="整改建议" v={it.remediation.action} />
                  <RiskItemRow k="复测方式" v={it.remediation.verification} />
                  <RiskItemRow k="对应的国家标准/行业规范条款" v={complianceLine(it.compliance)} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ReportDetailView({
  report,
  profile,
  onSelectProfile,
  severities,
  onToggleSeverity,
  riskDomains,
  onToggleRiskDomain,
  sections,
  onToggleSection,
}: {
  report: Report;
  profile: ReportExportProfile;
  onSelectProfile: (profile: ReportExportProfile) => void;
  severities: string[];
  onToggleSeverity: (s: string) => void;
  riskDomains: string[];
  onToggleRiskDomain: (domain: string) => void;
  sections: string[];
  onToggleSection: (s: string) => void;
}) {
  const summary = report.summary;
  if (summary.endpointSummary) return <EndpointReportPreview report={report} />;

  const assessment = assessReport(report);
  const riskDomainBars = firstAvailableBars(
    summary.charts?.riskDomain,
    report.riskDistribution.byRiskDomain,
    riskCategoryLabel,
  ).slice(0, 6);
  const severityBars = firstAvailableBars(
    summary.charts?.severity,
    report.riskDistribution.bySeverity,
    severityLabel,
  ).slice(0, 6);
  const categoryBars = firstAvailableBars(
    summary.charts?.riskCategory,
    report.riskDistribution.byRiskCategory,
    riskCategoryLabel,
  ).slice(0, 6);
  const conclusion = presentReportConclusion(summary.conclusionSnapshot);
  const nextSteps = buildNextSteps(report);
  const remediationItems = summary.remediationItems ?? [];
  const exportRiskDomains = (summary.charts?.riskDomain ?? []).filter((item) => item.value > 0);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge tone="info">{reportKindLabel(report.kind)}</Badge>
        <span className="text-xs text-muted-foreground">报告编号：{report.id.slice(0, 8)}</span>
      </div>

      <section className="mb-4 rounded-2xl border border-line bg-[#FAFBFE] p-5">
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-slate-900">选择交付模板</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            根据阅读对象选择模板，并按需限定风险范围。
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {REPORT_EXPORT_PROFILES.map((item) => {
            const meta = REPORT_EXPORT_PROFILE_META[item];
            const selected = profile === item;
            return (
              <button
                key={item}
                type="button"
                aria-pressed={selected}
                onClick={() => onSelectProfile(item)}
                className={`rounded-xl border p-3.5 text-left transition ${
                  selected
                    ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600'
                    : 'border-line-2 bg-white hover:border-brand-400'
                }`}
              >
                <span className="block text-sm font-semibold text-slate-900">{meta.label}</span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  {meta.description}
                </span>
              </button>
            );
          })}
        </div>
        {exportRiskDomains.length > 0 ? (
          <div className="mt-4 border-t border-slate-200 pt-3">
            <div className="mb-2 text-sm font-medium">风险领域</div>
            <div className="flex flex-wrap gap-2">
              {exportRiskDomains.map((item) => {
                const selected = riskDomains.includes(item.key);
                return (
                  <ChipToggle
                    key={item.key}
                    selected={selected}
                    onToggle={() => onToggleRiskDomain(item.key)}
                  >
                    {item.label} {item.value}
                  </ChipToggle>
                );
              })}
            </div>
          </div>
        ) : null}
      </section>

      <section className="mb-4 rounded-xl border border-line bg-[#F7F9FD] p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="mr-1 text-[13px] font-semibold text-ink">导出章节</span>
          {REPORT_SECTIONS.map((s) => {
            const on = sections.includes(s);
            return (
              <ChipToggle key={s} selected={on} onToggle={() => onToggleSection(s)}>
                {REPORT_SECTION_LABELS[s]}
              </ChipToggle>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          选择附加章节；概览、评分、风险分布和结论始终包含。导出内容按当前范围生成。
        </p>
      </section>

      <ReportVisualOverview
        report={report}
        assessment={assessment}
        riskDomainBars={riskDomainBars}
        severityBars={severityBars}
        categoryBars={categoryBars}
      />

      <ReportComprehensiveModuleCoverage report={report} />

      <ReportExplanationStatus report={report} />

      {(report.summary.riskItemsBySeverity?.length ?? 0) > 0 && (
        <section className="mb-4 rounded-2xl border border-line bg-white p-5 shadow-card">
          <div className="mb-3 flex items-center gap-2 text-base font-semibold">
            <AlertTriangle className="h-5 w-5 text-primary" />
            风险项明细
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="mr-1 text-[13px] font-semibold text-ink">按等级筛选</span>
            {SEVERITY_FILTER_ORDER.map((s) => {
              const on = severities.includes(s);
              return (
                <ChipToggle key={s} selected={on} onToggle={() => onToggleSeverity(s)}>
                  {SEVERITY_LABELS[s]}
                </ChipToggle>
              );
            })}
            <span className="text-xs text-muted-foreground">
              （筛选同时作用于「导出所选等级 PDF」）
            </span>
          </div>
          <RiskItemsDetail
            groups={report.summary.riskItemsBySeverity ?? []}
            severities={severities}
          />
        </section>
      )}

      <ReportEvidenceChain report={report} />

      <section className="mb-4 rounded-2xl border border-line bg-white p-5 shadow-card">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-base font-semibold">
              <ShieldCheck className="h-5 w-5 text-primary" />
              交付结论
            </div>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{assessment.summary}</p>
          </div>
          <div
            className={`shrink-0 rounded-md border px-3 py-2 text-sm font-semibold ${toneClasses(assessment.tone)}`}
          >
            {assessment.recommendation}
          </div>
        </div>
        <section className="mb-4 rounded-2xl border border-line bg-white p-5 shadow-card">
          <div className="mb-3 flex items-center gap-2 text-base font-semibold">
            <FileText className="h-5 w-5 text-primary" />
            评估范围
          </div>
          <div className="grid gap-3 text-sm md:grid-cols-3">
            <div className="rounded-xl border border-line bg-[#F7F9FD] p-3">
              <div className="text-xs text-muted-foreground">报告类型</div>
              <div className="mt-1 font-medium">{reportKindLabel(report.kind)}</div>
            </div>
            <div className="rounded-xl border border-line bg-[#F7F9FD] p-3">
              <div className="text-xs text-muted-foreground">测试样本</div>
              <div className="mt-1 font-medium tabular-nums">{summary.totalQuestions} 条</div>
            </div>
            <div className="rounded-xl border border-line bg-[#F7F9FD] p-3">
              <div className="text-xs text-muted-foreground">交付用途</div>
              <div className="mt-1 font-medium">留档备查、指导修复</div>
            </div>
          </div>
        </section>

        <div className="grid gap-3 md:grid-cols-4">
          <ReportMetric label="评估结论" value={assessment.level} tone={assessment.tone} />
          <ReportMetric
            label="有效判定通过率"
            value={
              passRatePercentValue(report) == null
                ? '—'
                : `${passRatePercentValue(report)!.toFixed(1)}%`
            }
            tone={assessment.tone}
            hint="只统计有效判定。"
          />
          <ReportMetric
            label="风险项"
            value={String(summary.findingCount)}
            tone={summary.findingCount > 0 ? 'warning' : 'success'}
          />
          <ReportMetric
            label="执行异常"
            value={String(summary.errorCount)}
            tone={summary.errorCount > 0 ? 'warning' : 'neutral'}
          />
        </div>
      </section>

      <section className="mb-4 rounded-2xl border border-line bg-white p-5 shadow-card">
        <div className="mb-3 flex items-center gap-2 text-base font-semibold">
          <BarChart3 className="h-5 w-5 text-primary" />
          风险聚合
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <ReportBarList title="按风险域" bars={riskDomainBars} empty="暂无风险域数据" />
          <ReportBarList title="按严重等级" bars={severityBars} empty="暂无严重等级风险" />
          <ReportBarList title="按风险类别" bars={categoryBars} empty="暂无风险类别数据" />
        </div>
      </section>

      <section className="mb-4 rounded-2xl border border-line bg-white p-5 shadow-card">
        <div className="mb-3 flex items-center gap-2 text-base font-semibold">
          <ClipboardList className="h-5 w-5 text-primary" />
          整改闭环
        </div>
        <div className="mb-3 text-sm font-medium">整改建议</div>
        {remediationItems.length > 0 ? (
          <div className="space-y-3">
            {remediationItems.map((item, index) => (
              <div
                key={`${item.priority}-${item.title}-${index}`}
                className="rounded-xl border border-line bg-[#F7F9FD] p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    tone={
                      item.priority === 'P0'
                        ? 'critical'
                        : item.priority === 'P1'
                          ? 'warning'
                          : item.priority === 'UNKNOWN'
                            ? 'warning'
                            : 'neutral'
                    }
                  >
                    <span
                      title={
                        item.priority === 'P0'
                          ? '最高优先级，必须先修'
                          : item.priority === 'P1'
                            ? '较紧急，尽快修'
                            : item.priority === 'UNKNOWN'
                              ? '优先级待人工确认'
                              : '常规，可排期修'
                      }
                    >
                      {item.priority === 'P0'
                        ? '最高优先级'
                        : item.priority === 'P1'
                          ? '高'
                          : item.priority === 'UNKNOWN'
                            ? '待定'
                            : '中'}
                    </span>
                  </Badge>
                  <span className="font-medium">{item.title}</span>
                  <span className="text-xs text-muted-foreground">{item.riskCategoryLabel}</span>
                </div>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.action}</p>
                <div className="mt-2 rounded-md border border-dashed border-border bg-background px-3 py-2 text-sm text-muted-foreground">
                  <span>验证方式：</span>
                  <span>{item.verification}</span>
                </div>
                {item.responsibility || item.verificationScope ? (
                  <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                    {item.responsibility ? <span>责任归属：{item.responsibility}</span> : null}
                    {item.verificationScope ? (
                      <span>复测范围：{item.verificationScope}</span>
                    ) : null}
                  </div>
                ) : null}
                <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                  <span>整改状态：{remediationStatusLabel(item.status)}</span>
                  <span>
                    截止时间：
                    {item.dueAt ? formatDateTime(item.dueAt) : '待客户补充'}
                  </span>
                  <span>复测任务：{item.retestTaskId ?? '待关联'}</span>
                  <span>关闭证据：{item.closureEvidence ?? '待补充'}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div
            className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
              conclusion.tone === 'info'
                ? 'border-sky-200 bg-sky-50 text-sky-700'
                : 'border-amber-200 bg-amber-50 text-amber-800'
            }`}
          >
            <CheckCircle2 className="h-4 w-4" />
            <span>
              {conclusion.title === '本次评估范围内未观察到有效风险'
                ? '当前范围未生成待整改风险项；请保留样本库并在变更后回归评估。'
                : '当前未生成可交付整改项，但报告结论尚不完整；请先补齐执行覆盖后复测。'}
            </span>
          </div>
        )}
      </section>

      <section className="mb-4 rounded-2xl border border-line bg-white p-5 shadow-card">
        <div className="mb-3 flex items-center gap-2 text-base font-semibold">
          <AlertTriangle className="h-5 w-5 text-primary" />
          复测计划
        </div>
        <div className="space-y-3">
          {nextSteps.map((step, index) => (
            <div
              key={step.title}
              className="flex gap-3 rounded-xl border border-line bg-[#F7F9FD] p-3"
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                {index + 1}
              </div>
              <div>
                <div className="font-medium">{step.title}</div>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{step.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ReportMetric({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone: AssessmentTone;
  hint?: string;
}) {
  return (
    <div className={`rounded-md border px-3 py-3 ${toneClasses(tone)}`}>
      <div className="text-xs font-medium opacity-80">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
      {hint ? <div className="mt-1 text-xs leading-4 opacity-80">{hint}</div> : null}
    </div>
  );
}

function ReportBarList({
  title,
  bars,
  empty,
}: {
  title: string;
  bars: ReportChartDatum[];
  empty: string;
}) {
  const max = Math.max(1, ...bars.map((bar) => bar.value));
  return (
    <div>
      <div className="mb-2 text-sm font-medium text-muted-foreground">{title}</div>
      {bars.length > 0 ? (
        <div className="space-y-2">
          {bars.map((bar) => (
            <div key={`${title}-${bar.key}`}>
              <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{bar.label}</span>
                <span className="font-mono text-xs text-muted-foreground">{bar.value}</span>
              </div>
              <div className="h-2 rounded-full bg-muted">
                <div
                  className="h-2 rounded-full bg-primary"
                  style={{ width: `${Math.max(6, (bar.value / max) * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
          {empty}
        </div>
      )}
    </div>
  );
}
