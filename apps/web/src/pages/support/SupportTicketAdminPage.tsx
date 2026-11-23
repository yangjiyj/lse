import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  supportApi,
  SUPPORT_KIND_LABELS,
  SUPPORT_STATUS_LABELS,
  SUPPORT_STATUS_TONES,
  type SupportTicketKind,
  type SupportTicketStatus,
} from '@/lib/support-tickets';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { SegmentTabs } from '@/components/page-kit/SegmentTabs';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { LoadingBlock } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { SUPPORT_QUERY_KEY, TicketDetailModal } from './TicketDetailModal';

const PAGE_SIZE = 20;
const KINDS: SupportTicketKind[] = ['SUPPORT', 'FEEDBACK'];
const STATUSES: SupportTicketStatus[] = ['OPEN', 'REPLIED', 'CLOSED'];

/** 系统管理 → 工单处理：全部租户的技术支持与意见反馈。 */
export function SupportTicketAdminPage() {
  const { hasPermission } = useAuth();
  const allowed = hasPermission('support:manage');
  const [kind, setKind] = useState<SupportTicketKind>('SUPPORT');
  const [status, setStatus] = useState<SupportTicketStatus | ''>('');
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<{ id: string; title: string } | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: [SUPPORT_QUERY_KEY, 'manage', kind, status, page],
    queryFn: () =>
      supportApi.manage({ kind, status: status || undefined, page, pageSize: PAGE_SIZE }),
    enabled: allowed,
  });

  if (!allowed) {
    return (
      <div>
        <PageHeader title="工单处理" />
        <EmptyState title="当前账号无此操作权限" />
      </div>
    );
  }

  const items = data?.items ?? [];
  return (
    <div>
      <PageHeader title="工单处理" />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <SegmentTabs
          ariaLabel="工单类型"
          items={KINDS.map((value) => ({ value, label: SUPPORT_KIND_LABELS[value] }))}
          value={kind}
          onChange={(value) => {
            setKind(value);
            setPage(1);
          }}
        />
        <Select
          aria-label="状态"
          className="w-36"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as SupportTicketStatus | '');
            setPage(1);
          }}
        >
          <option value="">全部状态</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {SUPPORT_STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
      </div>
      {isLoading ? (
        <LoadingBlock />
      ) : error ? (
        <p className="p-4 text-sm text-severity-critical">{(error as Error).message}</p>
      ) : items.length === 0 ? (
        <EmptyState title="暂无工单" />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>标题</TH>
                <TH>租户</TH>
                <TH>提交人</TH>
                <TH>状态</TH>
                <TH>回复</TH>
                <TH>更新时间</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((t) => (
                <TR key={t.id} className="h-12">
                  <TD data-label="标题">
                    <button
                      type="button"
                      className="text-left font-medium text-brand-700 hover:underline"
                      onClick={() => setViewing({ id: t.id, title: t.title })}
                    >
                      {t.title}
                    </button>
                  </TD>
                  <TD data-label="租户">{t.tenantName ?? '—'}</TD>
                  <TD data-label="提交人">{t.createdBy?.name ?? '—'}</TD>
                  <TD data-label="状态">
                    <Badge icon tone={SUPPORT_STATUS_TONES[t.status]}>
                      {SUPPORT_STATUS_LABELS[t.status]}
                    </Badge>
                  </TD>
                  <TD data-label="回复" className="font-num">
                    {t.replyCount}
                  </TD>
                  <TD data-label="更新时间">{formatDateTime(t.updatedAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={data?.total ?? 0}
            onPageChange={setPage}
          />
        </>
      )}
      {viewing && <TicketDetailModal ticket={viewing} manage onClose={() => setViewing(null)} />}
    </div>
  );
}
