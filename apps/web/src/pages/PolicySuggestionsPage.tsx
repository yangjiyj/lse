import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, policySuggestionsApi, type PolicySuggestion } from '@/lib/api';
import { PolicyStatusBadge } from './PolicyStatusBadge';
import { FilterBar } from '@/components/page-kit/FilterBar';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { LoadingBlock } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/lib/auth';
import { isPlatformTenantUser } from '@/lib/tenant';
import { formatDateTime } from '@/lib/format';
import { PolicySuggestionDetailModal } from './PolicySuggestionDetailModal';
import {
  GATEWAY_UNSUPPORTED_TEXT,
  POLICY_ACTION_LABELS,
  POLICY_STATUS_LABELS,
  POLICY_TYPE_LABELS,
  TYPE_EXPORT_ONLY_TEXT,
  downloadJson,
  matcherSummary,
  pct,
} from './policy-format';

const SECTION = 'rounded-card border border-[#EDF1F8] bg-white p-5 shadow-card';

const PAGE_SIZE = 20;

function compareText(s: PolicySuggestion): string {
  if (s.retestError) return s.retestError;
  if (s.preAttackRate == null && s.postAttackRate == null) return '—';
  return `${pct(s.preAttackRate)} → ${pct(s.postAttackRate)}`;
}

export function PolicySuggestionsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { hasPermission, user } = useAuth();
  // 与后端一致：生成/审核/下发/刷新要求 remediation:update，导出要求 remediation:read。
  const canUpdate = hasPermission('remediation:update');
  // 策略下发用的是全平台共用的网关：只在平台租户出现，其他租户导出后自行导入。
  const platformTenant = isPlatformTenantUser(user);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [taskId, setTaskId] = useState('');
  const [genTaskId, setGenTaskId] = useState('');
  const [genTargetId, setGenTargetId] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['policy-suggestions', page, status, taskId],
    queryFn: () =>
      policySuggestionsApi.list({
        page,
        pageSize: PAGE_SIZE,
        status: status || undefined,
        taskId: taskId || undefined,
      }),
  });
  const capability = useQuery({
    queryKey: ['policy-suggestions', 'capability'],
    queryFn: () => policySuggestionsApi.capability(),
    enabled: platformTenant,
  });
  const tasks = useQuery({
    queryKey: ['policy-suggestions', 'tasks'],
    queryFn: () => api.evalTasks.list({ page: 1, pageSize: 50, status: 'COMPLETED' }),
  });
  const targets = useQuery({
    queryKey: ['policy-suggestions', 'targets'],
    queryFn: () => api.modelTargets.list({ page: 1, pageSize: 50 }),
  });

  const items = list.data?.items ?? [];
  const dispatchIds = useMemo(
    () => items.filter((s) => s.dispatchable && s.gatewaySupported).map((s) => s.id),
    [items],
  );
  const supported = capability.data?.supported === true;
  const invalidate = () => qc.invalidateQueries({ queryKey: ['policy-suggestions'] });

  const generate = useMutation({
    mutationFn: () =>
      policySuggestionsApi.generate(
        genTaskId ? { taskId: genTaskId } : { modelTargetId: genTargetId },
      ),
    onSuccess: (r) => {
      toast.success(`新增 ${r.created} 条，刷新 ${r.updated} 条，已审核保持不变 ${r.skipped} 条`);
      void invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const dispatch = useMutation({
    mutationFn: () => policySuggestionsApi.dispatch(dispatchIds),
    onSuccess: (r) => {
      const ok = r.results.filter((x) => x.ok).length;
      const failed = r.results.filter((x) => !x.ok);
      if (failed.length)
        toast.error(`下发成功 ${ok} 条，失败 ${failed.length} 条：${failed[0]!.error ?? ''}`);
      else toast.success(`已下发 ${ok} 条，等待网关管理员审批`);
      void invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const exportAll = useMutation({
    mutationFn: () =>
      policySuggestionsApi.exportJson(
        items.filter((s) => s.status !== 'REJECTED').map((s) => s.id),
      ),
    onSuccess: (data) => downloadJson('lse-policy-suggestions.json', data),
    onError: (e: Error) => toast.error(e.message),
  });
  const exportable = items.some((s) => s.status !== 'REJECTED');

  return (
    <div>
      <PageHeader
        title="策略建议与下发"
        description={
          platformTenant
            ? '由评估证据生成网关防护策略，经人工审核后下发，发布后自动复测'
            : '由评估证据生成网关防护策略，经人工审核后导出'
        }
      />

      {canUpdate && (
        <section className={`mb-4 ${SECTION}`}>
          <div className="mb-3 text-[15px] font-bold text-ink">生成策略建议</div>
          <div className="flex flex-wrap items-center gap-2.5">
            <Select
              aria-label="按评估任务生成"
              value={genTaskId}
              onChange={(e) => {
                setGenTaskId(e.target.value);
                if (e.target.value) setGenTargetId('');
              }}
              className="max-w-[260px]"
            >
              <option value="">选择评估任务</option>
              {(tasks.data?.items ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            <span className="text-[13px] text-ink-3">或</span>
            <Select
              aria-label="按评估对象生成"
              value={genTargetId}
              onChange={(e) => {
                setGenTargetId(e.target.value);
                if (e.target.value) setGenTaskId('');
              }}
              className="max-w-[260px]"
            >
              <option value="">选择评估对象（最近 20 个任务）</option>
              {(targets.data?.items ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            <Button
              onClick={() => generate.mutate()}
              disabled={(!genTaskId && !genTargetId) || generate.isPending}
            >
              生成建议
            </Button>
          </div>
          <p className="mt-3 text-xs text-ink-3">
            规则由确定性模板与证据抽取生成，不由大模型直接产出；预估影响为在本批证据样本上的实测命中。
          </p>
        </section>
      )}

      <section className={`mb-4 flex flex-wrap items-center justify-between gap-3 py-4 ${SECTION}`}>
        {platformTenant ? (
        <div className="text-[13px]">
          <span className="font-semibold text-ink">网关能力：</span>
          {capability.isLoading ? (
            <span className="text-ink-3">探测中</span>
          ) : supported ? (
            <span className="text-severity-pass font-medium">网关已开放策略下发接口</span>
          ) : (
            <span className="font-medium text-severity-high">
              {GATEWAY_UNSUPPORTED_TEXT}
              {capability.data && !capability.data.configured
                ? `（${capability.data.message}）`
                : ''}
              {capability.data?.configured && !capability.data.reachable
                ? `（${capability.data.message}）`
                : ''}
            </span>
          )}
        </div>
        ) : (
          <div />
        )}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => exportAll.mutate()}
            disabled={!exportable || exportAll.isPending}
          >
            导出 JSON
          </Button>
          {canUpdate && platformTenant && (
            <Button
              onClick={() => dispatch.mutate()}
              disabled={!supported || dispatchIds.length === 0 || dispatch.isPending}
              title={
                supported
                  ? `将下发 ${dispatchIds.length} 条已采纳/已修改的建议`
                  : GATEWAY_UNSUPPORTED_TEXT
              }
            >
              一键下发
            </Button>
          )}
        </div>
      </section>

      <section className={SECTION}>
        <FilterBar>
          <Select
            aria-label="状态筛选"
            value={status}
            onChange={(e) => {
              setPage(1);
              setStatus(e.target.value);
            }}
            className="max-w-[160px]"
          >
            <option value="">全部状态</option>
            {Object.entries(POLICY_STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          <Select
            aria-label="任务筛选"
            value={taskId}
            onChange={(e) => {
              setPage(1);
              setTaskId(e.target.value);
            }}
            className="max-w-[260px]"
          >
            <option value="">全部任务</option>
            {(tasks.data?.items ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </FilterBar>

        {list.isLoading ? (
          <LoadingBlock />
        ) : items.length === 0 ? (
          <EmptyState
            title="暂无数据"
            description={`生成策略建议后，将在这里审核、采纳并${platformTenant ? '下发' : '导出'}。`}
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>类型</TH>
                  <TH>动作</TH>
                  <TH>匹配规则</TH>
                  <TH>预估影响</TH>
                  <TH>状态</TH>
                  <TH>下发前 → 下发后</TH>
                  <TH>生成时间</TH>
                  <TH>操作</TH>
                </TR>
              </THead>
              <TBody>
                {items.map((s) => (
                  <TR key={s.id}>
                    <TD className="py-3">
                      <div className="font-medium text-ink">
                        {POLICY_TYPE_LABELS[s.type] ?? s.type}
                      </div>
                      {platformTenant && !s.gatewaySupported && (
                        <div className="text-xs text-ink-3">{TYPE_EXPORT_ONLY_TEXT}</div>
                      )}
                    </TD>
                    <TD>{POLICY_ACTION_LABELS[s.action] ?? s.action}</TD>
                    <TD className="max-w-[320px] font-mono text-xs">
                      <div className="line-clamp-2 break-all" title={matcherSummary(s.matcher)}>
                        {matcherSummary(s.matcher)}
                      </div>
                    </TD>
                    <TD className="text-xs">
                      {s.estimatedImpact.hitCount}/{s.estimatedImpact.sampleCount}（
                      {pct(s.estimatedImpact.coverage)}）
                    </TD>
                    <TD>
                      <PolicyStatusBadge status={s.status} />
                      {s.dispatchError && (
                        <div
                          className="mt-1 max-w-[200px] truncate text-xs text-severity-critical"
                          title={s.dispatchError}
                        >
                          {s.dispatchError}
                        </div>
                      )}
                    </TD>
                    <TD className="text-xs">
                      {compareText(s)}
                      {s.retestTaskId && (
                        <div>
                          <Link
                            className="text-brand-700 hover:underline"
                            to={`/eval-tasks/${s.retestTaskId}`}
                          >
                            复测任务
                          </Link>
                        </div>
                      )}
                    </TD>
                    <TD className="whitespace-nowrap text-xs text-ink-3">
                      {formatDateTime(s.createdAt)}
                    </TD>
                    <TD>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-brand-700"
                        onClick={() => setDetailId(s.id)}
                      >
                        详情
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={list.data?.total ?? 0}
              onPageChange={setPage}
            />
          </>
        )}
      </section>

      <PolicySuggestionDetailModal
        id={detailId}
        onClose={() => setDetailId(null)}
        onChanged={() => void invalidate()}
        canUpdate={canUpdate}
      />
    </div>
  );
}
