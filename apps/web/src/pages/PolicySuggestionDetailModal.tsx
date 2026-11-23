import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { policySuggestionsApi, type PolicyMatcher, type PolicySuggestionDetail } from '@/lib/api';
import { PolicyStatusBadge } from './PolicyStatusBadge';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { LoadingBlock } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format';
import {
  MATCHER_KIND_LABELS,
  POLICY_ACTION_LABELS,
  POLICY_STATUS_LABELS,
  POLICY_TYPE_LABELS,
  RETEST_STATUS_LABELS,
  TYPE_EXPORT_ONLY_TEXT,
  matcherToInput,
  parseMatcherInput,
  pct,
} from './policy-format';

type Mode = 'view' | 'modify' | 'reject';
const REVIEWABLE = new Set(['DRAFT', 'ACCEPTED', 'MODIFIED']);
const REFRESHABLE = new Set(['DISPATCHED', 'GATEWAY_PENDING', 'PUBLISHED']);

interface Props {
  id: string | null;
  onClose: () => void;
  onChanged: () => void;
  /** 是否具有 remediation:update（审核/刷新接口要求的权限）；无权限时不渲染写操作按钮。 */
  canUpdate: boolean;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 border-b border-[#EEF2F8] py-2 text-[13px] last:border-0">
      <div className="w-24 shrink-0 font-medium text-ink-3">{label}</div>
      <div className="min-w-0 flex-1 break-all text-ink">{children}</div>
    </div>
  );
}

export function PolicySuggestionDetailModal({ id, onClose, onChanged, canUpdate }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>('view');
  const [note, setNote] = useState('');
  const [kind, setKind] = useState<PolicyMatcher['kind']>('regex');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['policy-suggestions', 'detail', id],
    queryFn: () => policySuggestionsApi.get(id!),
    enabled: Boolean(id),
  });
  const d = detail.data;

  useEffect(() => {
    setMode('view');
    setNote('');
    setError(null);
  }, [id]);
  useEffect(() => {
    if (d) {
      setKind(d.matcher.kind);
      setText(matcherToInput(d.matcher));
    }
  }, [d]);

  const done = (msg: string) => {
    toast.success(msg);
    setMode('view');
    setNote('');
    setError(null);
    void qc.invalidateQueries({ queryKey: ['policy-suggestions', 'detail', id] });
    onChanged();
  };
  const fail = (e: Error) => setError(e.message);

  const review = useMutation({
    mutationFn: (body: Parameters<typeof policySuggestionsApi.review>[1]) =>
      policySuggestionsApi.review(id!, body),
    onSuccess: (r) => done(`已${POLICY_STATUS_LABELS[r.status] ?? '更新'}`),
    onError: fail,
  });
  const refresh = useMutation({
    mutationFn: () => policySuggestionsApi.refresh(id!),
    onSuccess: (r) =>
      done(r.poll.polled ? '已从网关同步状态' : `未请求网关：${r.poll.reason ?? '无需刷新'}`),
    onError: fail,
  });

  const submitReject = () => {
    if (!note.trim()) {
      setError('驳回必须填写理由');
      return;
    }
    review.mutate({ decision: 'reject', note: note.trim() });
  };
  const submitModify = () => {
    const matcher = parseMatcherInput(kind, text);
    const empty = Array.isArray(matcher.value) ? matcher.value.length === 0 : !matcher.value;
    if (empty) {
      setError('匹配规则不能为空');
      return;
    }
    review.mutate({ decision: 'modify', matcher, note: note.trim() || undefined });
  };

  const reviewable = canUpdate && d ? REVIEWABLE.has(d.status) : false;
  const busy = review.isPending || refresh.isPending;

  const footer = !d ? null : mode === 'reject' ? (
    <>
      <Button variant="outline" onClick={() => setMode('view')} disabled={busy}>
        取消
      </Button>
      <Button variant="destructive" onClick={submitReject} disabled={busy}>
        确认驳回
      </Button>
    </>
  ) : mode === 'modify' ? (
    <>
      <Button variant="outline" onClick={() => setMode('view')} disabled={busy}>
        取消
      </Button>
      <Button onClick={submitModify} disabled={busy}>
        保存并重新校验
      </Button>
    </>
  ) : (
    <>
      {canUpdate && REFRESHABLE.has(d.status) && (
        <Button variant="outline" onClick={() => refresh.mutate()} disabled={busy}>
          刷新状态
        </Button>
      )}
      {reviewable && (
        <>
          <Button
            variant="outline"
            onClick={() => {
              setError(null);
              setMode('reject');
            }}
            disabled={busy}
          >
            驳回
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setError(null);
              setMode('modify');
            }}
            disabled={busy}
          >
            修改
          </Button>
          <Button onClick={() => review.mutate({ decision: 'accept' })} disabled={busy}>
            采纳
          </Button>
        </>
      )}
    </>
  );

  return (
    <Modal open={Boolean(id)} onClose={onClose} title="策略建议详情" size="lg" footer={footer}>
      {detail.isLoading || !d ? <LoadingBlock /> : renderBody(d)}
    </Modal>
  );

  function renderBody(s: PolicySuggestionDetail) {
    return (
      <div className="space-y-4">
        <div>
          <Row label="类型">
            {POLICY_TYPE_LABELS[s.type] ?? s.type}
            {!s.gatewaySupported && (
              <span className="ml-2 text-xs text-ink-3">{TYPE_EXPORT_ONLY_TEXT}</span>
            )}
          </Row>
          <Row label="动作">{POLICY_ACTION_LABELS[s.action] ?? s.action}</Row>
          <Row label="状态">
            <PolicyStatusBadge status={s.status} />
            {s.ruleSetVersion && (
              <span className="ml-2 text-ink-3">规则集版本 {s.ruleSetVersion}</span>
            )}
            {s.pollExpired && (
              <span className="ml-2 text-severity-high">网关审批超过 7 天，已停止轮询</span>
            )}
          </Row>
          <Row label="匹配规则">
            <span className="font-mono text-xs">
              {MATCHER_KIND_LABELS[s.matcher.kind]}：
              {matcherToInput(s.matcher).split('\n').join('、')}
            </span>
          </Row>
          <Row label="预估影响">{s.estimatedImpact.description}</Row>
          {s.generationNote && <Row label="生成说明">{s.generationNote}</Row>}
          {s.reviewNote && <Row label="审核意见">{s.reviewNote}</Row>}
          {s.dispatchError && (
            <Row label="下发错误">
              <span className="text-severity-critical">{s.dispatchError}</span>
            </Row>
          )}
          {s.dispatchedAt && <Row label="下发时间">{formatDateTime(s.dispatchedAt)}</Row>}
          <Row label="下发前后">
            {s.preAttackRate == null && s.postAttackRate == null
              ? '—'
              : `攻击成功率 ${pct(s.preAttackRate)} → ${pct(s.postAttackRate)}`}
            {s.retestStatus && (
              <span className="ml-2 text-ink-3">
                {RETEST_STATUS_LABELS[s.retestStatus] ?? s.retestStatus}
              </span>
            )}
            {s.retestTaskId && (
              <Link className="ml-2 text-brand-700" to={`/eval-tasks/${s.retestTaskId}`}>
                查看复测任务
              </Link>
            )}
          </Row>
        </div>

        {mode === 'modify' && (
          <div className="space-y-2 rounded-2xl border border-brand-100 bg-brand-50/50 p-4">
            <div className="text-[13px] font-semibold text-ink">修改匹配规则</div>
            <Select
              aria-label="匹配方式"
              value={kind}
              onChange={(e) => setKind(e.target.value as PolicyMatcher['kind'])}
              className="max-w-[160px]"
            >
              {Object.entries(MATCHER_KIND_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
            <Textarea
              aria-label="匹配规则内容"
              rows={4}
              className="font-mono text-xs"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <p className="text-xs text-ink-3">
              正则仅支持 RE2 子集（不支持回溯引用与环视，长度不超过
              256）；关键词/字段名一行一项。保存后将在证据样本上重新计算预估影响。
            </p>
          </div>
        )}
        {(mode === 'modify' || mode === 'reject') && (
          <Textarea
            aria-label={mode === 'reject' ? '驳回理由' : '修改说明'}
            rows={2}
            placeholder={mode === 'reject' ? '请填写驳回理由（必填）' : '修改说明（选填）'}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        )}
        {error && <p className="text-[13px] text-severity-critical">{error}</p>}

        <div>
          <div className="mb-2 text-[13px] font-semibold text-ink">
            证据（{s.sourceFindings.length}）
          </div>
          {s.sourceFindings.length === 0 ? (
            <div className="py-4 text-center text-[13px] text-ink-3">暂无数据</div>
          ) : (
            <div className="max-h-64 space-y-2 overflow-y-auto">
              {s.sourceFindings.map((f) => (
                <div key={f.id} className="rounded-xl border border-line bg-[#F7F9FD] p-3 text-xs">
                  <div className="mb-1 font-medium text-ink">{f.title ?? f.riskCategory}</div>
                  {f.result && <div className="break-all text-ink-2">提问：{f.result.prompt}</div>}
                  {f.evidence && <div className="break-all text-ink-2">证据：{f.evidence}</div>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="mb-2 text-[13px] font-semibold text-ink">下发内容预览</div>
          <pre className="max-h-48 overflow-auto rounded-xl border border-line bg-[#F7F9FD] p-3 text-xs">
            {JSON.stringify(s.payloadPreview, null, 2)}
          </pre>
        </div>
      </div>
    );
  }
}
