import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  supportApi,
  SUPPORT_STATUS_LABELS,
  SUPPORT_STATUS_TONES,
  type SupportTicketDetail,
} from '@/lib/support-tickets';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { LoadingBlock } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';

export const SUPPORT_QUERY_KEY = 'support-tickets';

/** 工单详情：原文、往来回复、追加回复；处理人另有「关闭工单」。 */
export function TicketDetailModal({
  ticket,
  manage = false,
  onClose,
}: {
  ticket: { id: string; title: string };
  manage?: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { success, error: toastError } = useToast();
  const [content, setContent] = useState('');
  const detailKey = [SUPPORT_QUERY_KEY, 'detail', ticket.id];
  const { data, isLoading, error } = useQuery({
    queryKey: detailKey,
    queryFn: () => supportApi.get(ticket.id),
  });
  const applyDetail = (detail: SupportTicketDetail) => {
    queryClient.setQueryData(detailKey, detail);
    void queryClient.invalidateQueries({ queryKey: [SUPPORT_QUERY_KEY] });
  };
  const reply = useMutation({
    mutationFn: () => supportApi.reply(ticket.id, content.trim()),
    onSuccess: (detail) => {
      setContent('');
      applyDetail(detail);
    },
    onError: (e: Error) => toastError(e.message),
  });
  const close = useMutation({
    mutationFn: () => supportApi.close(ticket.id),
    onSuccess: (detail) => {
      success('工单已关闭');
      applyDetail(detail);
    },
    onError: (e: Error) => toastError(e.message),
  });
  const closed = data?.status === 'CLOSED';

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={ticket.title}
      footer={
        <>
          {manage && data && !closed && (
            <Button
              variant="outline"
              disabled={close.isPending}
              onClick={() => {
                if (window.confirm('关闭后双方都不能再回复，确定关闭？')) close.mutate();
              }}
            >
              关闭工单
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            完成
          </Button>
        </>
      }
    >
      {isLoading ? (
        <LoadingBlock />
      ) : error ? (
        <p className="text-sm text-severity-critical">{(error as Error).message}</p>
      ) : data ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3 text-[13px] text-ink-3">
            <Badge icon tone={SUPPORT_STATUS_TONES[data.status]}>
              {SUPPORT_STATUS_LABELS[data.status]}
            </Badge>
            {data.createdBy && <span>{data.createdBy.name}</span>}
            <span>{formatDateTime(data.createdAt)}</span>
          </div>
          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-ink">
            {data.content}
          </p>
          {data.replies.length > 0 && (
            <ol className="flex flex-col gap-2 border-t border-line pt-4">
              {data.replies.map((r) => (
                <li
                  key={r.id}
                  className={cn(
                    'rounded-[10px] px-3 py-2',
                    r.byCreator ? 'bg-canvas' : 'bg-brand-50',
                  )}
                >
                  <div className="flex items-center gap-2 text-xs text-ink-3">
                    <span className="font-medium text-ink-2">{r.author?.name ?? '—'}</span>
                    <span>{formatDateTime(r.createdAt)}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-ink">
                    {r.content}
                  </p>
                </li>
              ))}
            </ol>
          )}
          {!closed && (
            <div className="flex flex-col gap-2">
              <Textarea
                aria-label="回复"
                value={content}
                maxLength={5000}
                onChange={(e) => setContent(e.target.value)}
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  disabled={!content.trim() || reply.isPending}
                  onClick={() => reply.mutate()}
                >
                  发送
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </Modal>
  );
}
