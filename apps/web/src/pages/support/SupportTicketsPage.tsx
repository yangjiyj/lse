import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  supportApi,
  SUPPORT_KIND_LABELS,
  SUPPORT_STATUS_LABELS,
  SUPPORT_STATUS_TONES,
  type SupportTicketKind,
} from '@/lib/support-tickets';
import { formatDateTime } from '@/lib/format';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Field } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/badge';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { LoadingBlock } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toast';
import { SUPPORT_QUERY_KEY, TicketDetailModal } from './TicketDetailModal';

const PAGE_SIZE = 20;
const SUBMIT_LABELS: Record<SupportTicketKind, string> = {
  SUPPORT: '提交工单',
  FEEDBACK: '提交反馈',
};

function CreateTicketModal({
  kind,
  onClose,
  onCreated,
}: {
  kind: SupportTicketKind;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => supportApi.create({ kind, title: title.trim(), content: content.trim() }),
    onSuccess: onCreated,
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={SUBMIT_LABELS[kind]}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={!title.trim() || !content.trim() || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            提交
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="标题" htmlFor="support-title" required>
          <Input
            id="support-title"
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="内容" htmlFor="support-content" required>
          <Textarea
            id="support-content"
            value={content}
            maxLength={5000}
            rows={6}
            onChange={(e) => setContent(e.target.value)}
          />
        </Field>
        {error && <p className="text-sm text-severity-critical">{error}</p>}
      </div>
    </Modal>
  );
}

/** 我的技术支持 / 意见反馈：列表、提交、详情与回复。 */
export function SupportTicketsPage({ kind }: { kind: SupportTicketKind }) {
  const queryClient = useQueryClient();
  const { success } = useToast();
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<{ id: string; title: string } | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: [SUPPORT_QUERY_KEY, 'mine', kind, page],
    queryFn: () => supportApi.mine({ kind, page, pageSize: PAGE_SIZE }),
  });
  const items = data?.items ?? [];

  return (
    <div>
      <PageHeader
        title={SUPPORT_KIND_LABELS[kind]}
        actions={<Button onClick={() => setCreating(true)}>{SUBMIT_LABELS[kind]}</Button>}
      />
      {isLoading ? (
        <LoadingBlock />
      ) : error ? (
        <p className="p-4 text-sm text-severity-critical">{(error as Error).message}</p>
      ) : items.length === 0 ? (
        <EmptyState title={kind === 'SUPPORT' ? '暂无工单' : '暂无反馈'} />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>标题</TH>
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
      {creating && (
        <CreateTicketModal
          kind={kind}
          onClose={() => setCreating(false)}
          onCreated={() => {
            success('已提交');
            setCreating(false);
            setPage(1);
            void queryClient.invalidateQueries({ queryKey: [SUPPORT_QUERY_KEY] });
          }}
        />
      )}
      {viewing && <TicketDetailModal ticket={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
