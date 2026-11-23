import { useQuery } from '@tanstack/react-query';
import { FileKey2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Modal } from '@/components/ui/modal';
import { LoadingBlock } from '@/components/ui/spinner';

interface AssuranceEvidenceDrawerProps {
  open: boolean;
  runId: string | null;
  canReview: boolean;
  onClose: () => void;
}

export function AssuranceEvidenceDrawer({
  open,
  runId,
  canReview,
  onClose,
}: AssuranceEvidenceDrawerProps) {
  const evidenceQuery = useQuery({
    queryKey: ['service-assurance', 'evidence', runId],
    queryFn: () => api.serviceAssurance.evidence(runId!),
    enabled: open && canReview && !!runId,
  });

  return (
    <Modal
      open={open && canReview}
      onClose={onClose}
      title="技术证据"
      description="仅展示经过脱敏和限长处理的核验记录。"
      size="lg"
    >
      {evidenceQuery.isLoading ? (
        <LoadingBlock label="正在加载技术证据" />
      ) : evidenceQuery.isError ? (
        <p className="text-sm text-red-700">技术证据暂时无法加载。</p>
      ) : (evidenceQuery.data?.items.length ?? 0) === 0 ? (
        <p className="text-sm text-ink-3">当前运行没有可查看的技术证据。</p>
      ) : (
        <div className="space-y-3">
          {evidenceQuery.data!.items.map((item, index) => (
            <section
              key={item.evidenceId}
              className="min-w-0 rounded-md border border-line bg-canvas p-4"
            >
              <div className="flex min-w-0 items-start gap-3">
                <FileKey2 className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" />
                <div className="min-w-0 flex-1">
                  <h3 className="break-words text-sm font-semibold text-ink">
                    {item.ruleSummary ?? `技术证据 ${index + 1}`}
                  </h3>
                  <p className="mt-1 break-words text-sm leading-6 text-ink-2">
                    {item.customerSummary}
                  </p>
                </div>
              </div>
              <dl className="mt-3 grid min-w-0 gap-3 text-xs sm:grid-cols-2">
                {item.ruleId && (
                  <div className="min-w-0">
                    <dt className="font-semibold text-ink-3">规则标识</dt>
                    <dd className="mt-1 break-all text-ink">{item.ruleId}</dd>
                  </div>
                )}
                {item.matchedLocation && (
                  <div className="min-w-0">
                    <dt className="font-semibold text-ink-3">命中位置</dt>
                    <dd className="mt-1 break-words text-ink">{item.matchedLocation}</dd>
                  </div>
                )}
                {item.requestSummary && (
                  <div className="min-w-0">
                    <dt className="font-semibold text-ink-3">请求摘要</dt>
                    <dd className="mt-1 break-all font-mono text-ink">{item.requestSummary}</dd>
                  </div>
                )}
                {item.responseSummary && (
                  <div className="min-w-0">
                    <dt className="font-semibold text-ink-3">响应摘要</dt>
                    <dd className="mt-1 break-all font-mono text-ink">{item.responseSummary}</dd>
                  </div>
                )}
                <div className="min-w-0 sm:col-span-2">
                  <dt className="font-semibold text-ink-3">证据校验值</dt>
                  <dd className="mt-1 break-all font-mono text-ink">{item.contentSha256}</dd>
                </div>
              </dl>
            </section>
          ))}
        </div>
      )}
    </Modal>
  );
}
