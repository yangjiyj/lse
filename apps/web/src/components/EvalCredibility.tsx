import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, ClipboardCheck, Sigma } from 'lucide-react';
import { api, type EvalDifferenceHint, type EvalTaskStatistics } from '@/lib/api';
import { formatPercent, severityLabel } from '@/lib/format';
import { Button } from '@/components/ui/button';

/** 失败率区间文案：「12.3%（95% 置信区间 8.1% ~ 18.2%）」。 */
export function formatFailRateWithInterval(s: EvalTaskStatistics | undefined | null): string {
  if (!s || s.failRate === null) return '—';
  return `${formatPercent(s.failRate)}（置信区间 ${formatPercent(s.failRateLower)} ~ ${formatPercent(s.failRateUpper)}）`;
}

/** 差异可信度提示的文案与配色。 */
export function differenceTone(hint: EvalDifferenceHint): { text: string; className: string } {
  if (hint.verdict === 'beyond_noise') return { text: hint.message, className: 'text-emerald-700' };
  if (hint.verdict === 'within_noise') return { text: hint.message, className: 'text-amber-700' };
  return { text: hint.message, className: 'text-slate-500' };
}

/** 任务汇总处：发现风险比例（失败率）+ 置信区间 + 样本量 + 小样本警告 + 未判定占比。 */
export function TaskStatisticsCard({ statistics }: { statistics?: EvalTaskStatistics }) {
  if (!statistics) return null;
  const s = statistics;
  return (
    <div
      className="rounded-card border border-[#EDF1F8] bg-white p-6 shadow-card"
      data-testid="task-statistics"
    >
      <div className="flex items-center gap-2 text-[15px] font-bold text-ink">
        <Sigma className="h-5 w-5 text-primary" />
        结果可信度
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="text-xs text-muted-foreground">发现风险比例（失败率）</div>
          <div className="mt-1 text-xl font-semibold tabular-nums">{formatPercent(s.failRate)}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">95% 置信区间</div>
          <div className="mt-1 text-xl font-semibold tabular-nums">
            {s.failRate === null
              ? '—'
              : `${formatPercent(s.failRateLower)} ~ ${formatPercent(s.failRateUpper)}`}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">有效样本量</div>
          <div className="mt-1 text-xl font-semibold tabular-nums">{s.sampleSize}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">未判定（不计为通过）</div>
          <div className="mt-1 text-xl font-semibold tabular-nums text-severity-medium">
            {s.unknownCount}
            <span className="ml-1 text-sm font-normal text-muted-foreground">
              （{formatPercent(s.unknownRate)}）
            </span>
          </div>
        </div>
      </div>
      {s.warnings.length > 0 && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            {s.warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
        </div>
      )}
      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        测了 {s.sampleSize} 条，其中 {s.failedCount} 条有风险；
        {s.sampleSize < 30 ? '样本太少，这个比例只能参考。' : '此比例只反映本次测试范围。'}
      </p>
      <details className="mt-2 text-xs leading-5 text-muted-foreground">
        <summary className="cursor-pointer">了解更多</summary>
        <p>
          样本越少，风险比例的波动越大。未判定不计为通过；执行异常不进入比例计算。补充测试或人工复核后再用于正式决策。
        </p>
      </details>
    </div>
  );
}

const FIELD = 'text-xs text-muted-foreground';

/** 任务详情「判定可信度」卡片：人工复核校准 + 随机抽检入口。 */
export function JudgeCalibrationCard({ taskId }: { taskId: string }) {
  const [size, setSize] = useState(20);
  const [seed, setSeed] = useState('');
  const query = useQuery({
    queryKey: ['judge-calibration', taskId],
    queryFn: () => api.evalTasks.judgeCalibration(taskId),
  });
  const sample = useMutation({
    mutationFn: () =>
      api.evalTasks.judgeCalibrationSample(taskId, {
        size,
        ...(seed.trim() ? { seed: seed.trim() } : {}),
      }),
  });
  const c = query.data;
  if (query.isError) return null;
  const ids = sample.data?.items.map((i) => i.findingId).join(',') ?? '';
  return (
    <div
      className="rounded-card border border-[#EDF1F8] bg-white p-6 shadow-card"
      data-testid="judge-calibration"
    >
      <div className="flex items-center gap-2 text-[15px] font-bold text-ink">
        <ClipboardCheck className="h-5 w-5 text-primary" />
        判定可信度
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        自动判定可能出错，请抽查具体结果后再用于正式决策。
      </p>
      <details className="mt-2 text-xs leading-5 text-muted-foreground">
        <summary className="cursor-pointer">了解更多</summary>
        <p>
          漏报是自动判定无风险、但人工发现风险；误报是自动判定有风险、但人工确认无风险。下方对照人工复核结果，帮助判断是否需要调整规则。
        </p>
      </details>
      {c && c.status === 'INSUFFICIENT' && (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          {c.message}
        </div>
      )}
      {c && c.status === 'OK' && (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <div className={FIELD}>人工已复核样本</div>
              <div className="mt-1 text-xl font-semibold tabular-nums">{c.reviewedCount}</div>
            </div>
            <div>
              <div className={FIELD}>判定与人工一致率</div>
              <div className="mt-1 text-xl font-semibold tabular-nums">
                {formatPercent(c.agreementRate)}
              </div>
              <div className="text-xs text-muted-foreground">
                区间 {formatPercent(c.agreementLower)} ~ {formatPercent(c.agreementUpper)}
              </div>
            </div>
            <div>
              <div className={FIELD}>一致性系数（已扣除碰巧一致）</div>
              <div className="mt-1 text-xl font-semibold tabular-nums">
                {c.kappa === null ? '—' : c.kappa.toFixed(2)}
              </div>
              <div className="text-xs text-muted-foreground">{c.kappaLevel}</div>
            </div>
            <div>
              <div className={FIELD}>漏报（判通过、人工有风险）</div>
              <div className="mt-1 text-xl font-semibold tabular-nums text-destructive">
                {c.missedRiskCount}
              </div>
            </div>
            <div>
              <div className={FIELD}>误报（判有风险、人工无风险）</div>
              <div className="mt-1 text-xl font-semibold tabular-nums text-severity-medium">
                {c.falseAlarmCount}
              </div>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{c.message}</p>
        </>
      )}
      {c && c.excludedReviewedCount > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          另有 {c.excludedReviewedCount} 条人工已复核但判定为「未判定/异常」，未纳入一致率计算。
        </p>
      )}

      <div className="mt-4 border-t border-slate-200 pt-4">
        <div className="text-sm font-medium">随机抽检</div>
        <p className="mt-1 text-xs text-muted-foreground">
          从尚未人工复核的风险样本中按种子随机抽取，相同种子得到相同清单，便于多人分工与复现。
          {c ? `当前待复核 ${c.pendingCount} 条。` : ''}
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-3">
          <label className="text-xs text-muted-foreground">
            抽取数量
            <input
              aria-label="抽取数量"
              type="number"
              min={1}
              max={200}
              value={size}
              onChange={(e) => setSize(Math.min(200, Math.max(1, Number(e.target.value) || 1)))}
              className="mt-1 block h-9 w-24 rounded-md border border-slate-200 px-2 text-sm text-slate-900"
            />
          </label>
          <label className="text-xs text-muted-foreground">
            随机种子（可选）
            <input
              aria-label="随机种子"
              type="text"
              value={seed}
              maxLength={64}
              onChange={(e) => setSeed(e.target.value)}
              placeholder="留空则自动生成"
              className="mt-1 block h-9 w-44 rounded-md border border-slate-200 px-2 text-sm text-slate-900"
            />
          </label>
          <Button onClick={() => sample.mutate()} disabled={sample.isPending}>
            {sample.isPending ? '抽取中…' : '随机抽取'}
          </Button>
        </div>
        {sample.isError && <p className="mt-2 text-sm text-destructive">抽取失败，请稍后重试。</p>}
        {sample.data && (
          <div className="mt-3" data-testid="spot-check-list">
            {sample.data.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">没有可抽检的待复核样本。</p>
            ) : (
              <>
                <p className="text-sm">
                  已抽取 {sample.data.size} 条（待复核池共 {sample.data.poolSize} 条，种子「
                  {sample.data.seed}」）。
                  <Link
                    className="ml-2 text-primary hover:underline"
                    to={`/wrong-answers?taskId=${encodeURIComponent(taskId)}&findingIds=${ids}`}
                  >
                    前往风险样本逐条复核
                  </Link>
                </p>
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {sample.data.items.map((i) => (
                    <li key={i.findingId}>
                      {severityLabel(i.severity)} · {i.title ?? i.riskCategory}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
