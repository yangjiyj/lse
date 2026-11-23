import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, modelFilesApi, type ModelFileFindingRecord } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, severityLabel } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { LoadingBlock } from '@/components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';

const RISK_COLOR: Record<string, string> = {
  CRITICAL: '#B42318',
  HIGH: '#B42318',
  MEDIUM: '#B04A05',
};
export const REVIEW_LABEL: Record<ModelFileFindingRecord['reviewStatus'], string> = {
  UNREVIEWED: '未复核',
  NEEDS_REVIEW: '待人工复核',
  CONFIRMED: '已确认',
  FALSE_POSITIVE: '误报',
  ACCEPTED_RISK: '接受风险',
};
/** 筛选项里的补充说明：这两个状态都属于首页「待复核」，接口只支持单值，故分别列出并说明。 */
const REVIEW_FILTER_HINT: Partial<Record<ModelFileFindingRecord['reviewStatus'], string>> = {
  UNREVIEWED: '（尚未处理，计入待复核）',
  NEEDS_REVIEW: '（已标记需人工确认，计入待复核）',
};
export const REMEDIATION_LABEL: Record<ModelFileFindingRecord['remediationStatus'], string> = {
  OPEN: '待整改',
  IN_PROGRESS: '整改中',
  READY_FOR_RETEST: '待复扫',
  VERIFIED_CLOSED: '已验证关闭',
  REOPENED: '已重开',
  NOT_APPLICABLE: '不适用',
};

type Row = Awaited<ReturnType<typeof modelFilesApi.remediationFindings>>['items'][number];

/** 风险处置台来源：模型文件扫描（组件安全），支持复核与整改；验证关闭以同路径复扫为依据。 */
export function ModelFileFindingSource() {
  const { user, hasPermission } = useAuth();
  const [page, setPage] = useState(1);
  const [review, setReview] = useState('');
  const [editing, setEditing] = useState<Row | null>(null);
  const q = useQuery({
    queryKey: ['model-files', 'remediation-source', page, review],
    queryFn: () =>
      modelFilesApi.remediationFindings({ page, pageSize: 10, reviewStatus: review || undefined }),
  });
  const canEdit = (f: Row) =>
    hasPermission('remediation:update') && (user?.isBuiltin || f.scan.createdById === user?.id);
  return (
    <section className="rounded-lg border border-border bg-white" aria-label="模型文件扫描来源">
      <div className="flex h-11 items-center justify-between gap-3 border-b border-border px-4">
        <h2 className="text-sm font-medium">来源：模型文件扫描（组件安全）</h2>
        <div className="flex items-center gap-3">
          <Select
            aria-label="按复核状态筛选"
            value={review}
            onChange={(e) => {
              setReview(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部复核状态</option>
            {Object.entries(REVIEW_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
                {REVIEW_FILTER_HINT[k as ModelFileFindingRecord['reviewStatus']] ?? ''}
              </option>
            ))}
          </Select>
          <Link to="/inspect/model-files" className="whitespace-nowrap text-sm text-brand-600">
            前往模型文件扫描
          </Link>
        </div>
      </div>
      <div className="p-4">
        {q.isLoading ? (
          <LoadingBlock label="正在加载…" />
        ) : (q.data?.items ?? []).length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            暂无中危及以上的模型文件问题。可在「模型文件扫描」上传模型或扫描服务器上的模型目录。
          </p>
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>时间</TH>
                  <TH>评估对象</TH>
                  <TH>文件</TH>
                  <TH>严重度</TH>
                  <TH>问题</TH>
                  <TH>证据</TH>
                  <TH>复核</TH>
                  <TH>整改</TH>
                  <TH>操作</TH>
                </TR>
              </THead>
              <TBody>
                {q.data!.items.map((f) => (
                  <TR key={f.id}>
                    <TD className="tabular-nums">{formatDateTime(f.scan.createdAt)}</TD>
                    <TD>{f.scan.target?.name ?? '—'}</TD>
                    <TD
                      className="max-w-[200px] truncate font-mono text-xs"
                      title={`${f.scan.path} · ${f.filePath}`}
                    >
                      {f.filePath}
                    </TD>
                    <TD>
                      <span style={{ color: RISK_COLOR[f.severity] }}>
                        {severityLabel(f.severity)}
                      </span>
                    </TD>
                    <TD>{f.title}</TD>
                    <TD className="max-w-[280px] break-all text-xs">{f.evidence}</TD>
                    <TD>{REVIEW_LABEL[f.reviewStatus]}</TD>
                    <TD>{REMEDIATION_LABEL[f.remediationStatus]}</TD>
                    <TD>
                      {canEdit(f) ? (
                        <button
                          type="button"
                          className="text-brand-600"
                          onClick={() => setEditing(f)}
                        >
                          处置
                        </button>
                      ) : (
                        <span className="text-muted-foreground" title="仅扫描发起人或管理员可处置">
                          —
                        </span>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination
              page={page}
              pageSize={10}
              total={q.data?.total ?? 0}
              onPageChange={setPage}
            />
          </>
        )}
      </div>
      {editing && <DisposeModal finding={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function DisposeModal({ finding, onClose }: { finding: Row; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [reviewStatus, setReviewStatus] = useState(finding.reviewStatus);
  const [reason, setReason] = useState(finding.reviewReason ?? '');
  const [status, setStatus] = useState(finding.remediationStatus);
  const [owner, setOwner] = useState(finding.remediationOwner ?? '');
  const [dueAt, setDueAt] = useState(finding.remediationDueAt?.slice(0, 10) ?? '');
  const [record, setRecord] = useState(finding.remediationRecord ?? '');
  const [evidence, setEvidence] = useState(finding.remediationClosureEvidence ?? '');
  const [retest, setRetest] = useState(finding.remediationRetestScanId ?? '');
  const retests = useQuery({
    queryKey: ['model-files', 'scans', 'retest-candidates'],
    queryFn: () => modelFilesApi.list({ pageSize: 100 }),
    enabled: status === 'VERIFIED_CLOSED',
  });
  const candidates = (retests.data?.items ?? []).filter(
    (s) =>
      s.status === 'COMPLETED' &&
      s.path === finding.scan.path &&
      s.id !== finding.scanId &&
      s.createdAt > finding.scan.createdAt,
  );
  const save = useMutation({
    mutationFn: async () => {
      if (reviewStatus !== finding.reviewStatus || reason !== (finding.reviewReason ?? ''))
        await modelFilesApi.reviewFinding(finding.id, {
          status: reviewStatus,
          reason: reason || null,
        });
      const changed =
        status !== finding.remediationStatus ||
        owner !== (finding.remediationOwner ?? '') ||
        dueAt !== (finding.remediationDueAt?.slice(0, 10) ?? '') ||
        record !== (finding.remediationRecord ?? '') ||
        evidence !== (finding.remediationClosureEvidence ?? '') ||
        retest !== (finding.remediationRetestScanId ?? '');
      if (!changed) return { reopened: false };
      return modelFilesApi.updateFinding(finding.id, {
        status,
        owner: owner || null,
        dueAt: dueAt ? new Date(`${dueAt}T23:59:59+08:00`).toISOString() : null,
        record: record || null,
        closureEvidence: evidence || null,
        retestScanId: retest || null,
      });
    },
    onSuccess: (r) => {
      if (r.reopened) toast.error('复扫仍命中同一文件的同一规则，已自动重开');
      else toast.success('已保存');
      void qc.invalidateQueries({ queryKey: ['model-files'] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : '保存失败'),
  });
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="处置模型文件发现"
      description={`${finding.title} · ${finding.filePath}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            保存
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="复核结论" htmlFor="mff-review">
          <Select
            id="mff-review"
            value={reviewStatus}
            onChange={(e) => setReviewStatus(e.target.value as typeof reviewStatus)}
          >
            {Object.entries(REVIEW_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="整改状态" htmlFor="mff-status">
          <Select
            id="mff-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
          >
            {Object.entries(REMEDIATION_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="复核依据"
          htmlFor="mff-reason"
          hint="非「未复核」时必填。"
          className="sm:col-span-2"
        >
          <Textarea
            id="mff-reason"
            rows={2}
            maxLength={4000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <Field label="责任人" htmlFor="mff-owner">
          <Input
            id="mff-owner"
            maxLength={128}
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          />
        </Field>
        <Field label="整改期限" htmlFor="mff-due">
          <Input
            id="mff-due"
            type="date"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
          />
        </Field>
        <Field
          label="处置记录"
          htmlFor="mff-record"
          hint="标记「不适用」时必填。"
          className="sm:col-span-2"
        >
          <Textarea
            id="mff-record"
            rows={2}
            maxLength={4000}
            value={record}
            onChange={(e) => setRecord(e.target.value)}
          />
        </Field>
        {status === 'VERIFIED_CLOSED' && (
          <>
            <Field
              label="关闭证据"
              htmlFor="mff-evidence"
              hint="如：已替换为 safetensors 并删除原 .bin。"
              className="sm:col-span-2"
            >
              <Textarea
                id="mff-evidence"
                rows={2}
                maxLength={4000}
                value={evidence}
                onChange={(e) => setEvidence(e.target.value)}
              />
            </Field>
            <Field
              label="复扫记录"
              htmlFor="mff-retest"
              className="sm:col-span-2"
              hint={
                candidates.length === 0
                  ? `暂无可用复扫：请先对「${finding.scan.path}」重新发起一次扫描，完成后再来关闭。`
                  : '复扫中同一文件不再命中同一规则才能关闭，否则自动重开。'
              }
            >
              <Select id="mff-retest" value={retest} onChange={(e) => setRetest(e.target.value)}>
                <option value="">请选择</option>
                {candidates.map((s) => (
                  <option key={s.id} value={s.id}>
                    {formatDateTime(s.createdAt)} · 高危 {s.highCount} / 中危 {s.mediumCount}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}
