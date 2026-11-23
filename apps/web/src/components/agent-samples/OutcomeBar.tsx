import { cn } from '@/lib/utils';

export interface OutcomeCounts {
  allowed: number;
  model_refused: number;
  control_blocked: number;
  invalid: number;
}

/** 结局语义色与报告一致：红=照做，绿=识破，蓝=被拦截，灰斜纹=无效（斜纹 + 文字，不只靠颜色）。 */
const SEGMENTS: Array<{ key: keyof OutcomeCounts; label: string; className: string }> = [
  { key: 'allowed', label: '照做', className: 'bg-[#B3261E] text-white' },
  { key: 'control_blocked', label: '被拦截', className: 'bg-[#175A96] text-white' },
  { key: 'model_refused', label: '识破', className: 'bg-[#1E9E5A] text-white' },
  {
    key: 'invalid',
    label: '无效',
    className: 'bg-[repeating-linear-gradient(135deg,#7A8594_0_2px,#C9CFD8_2px_4px)] text-slate-800',
  },
];

/** 一行结局堆叠条：读屏读「标签：照做 n · 识破 n · 被拦截 n · 无效 n」，没有运行写「暂无运行」。 */
export function OutcomeBar({ label, counts }: { label: string; counts: OutcomeCounts }) {
  const total = counts.allowed + counts.model_refused + counts.control_blocked + counts.invalid;
  const description = `${label}：照做 ${counts.allowed} · 识破 ${counts.model_refused} · 被拦截 ${counts.control_blocked} · 无效 ${counts.invalid}`;
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_3.5rem] items-center gap-2 text-xs">
      <span className="text-ink-2">{label}</span>
      {total ? (
        <div role="img" aria-label={description} className="flex h-4 gap-0.5 overflow-hidden rounded">
          {SEGMENTS.filter((s) => counts[s.key] > 0).map((s) => (
            <div
              key={s.key}
              className={cn('flex min-w-[2px] items-center justify-center text-[11px] font-semibold', s.className)}
              style={{ flex: counts[s.key] }}
              title={`${s.label} ${counts[s.key]}`}
            >
              {counts[s.key] / total >= 0.12 ? counts[s.key] : ''}
            </div>
          ))}
        </div>
      ) : (
        <div role="img" aria-label={`${label}：暂无运行`} className="flex h-4 items-center justify-center rounded border border-dashed border-line text-[11px] text-ink-3">
          暂无运行
        </div>
      )}
      <span className="text-right text-ink-3">{total ? `${total} 次` : ''}</span>
    </div>
  );
}

export function OutcomeLegend() {
  return (
    <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-3">
      {SEGMENTS.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1">
          <i className={cn('inline-block h-2.5 w-2.5 rounded-sm', s.className)} aria-hidden="true" />
          {s.label}
        </span>
      ))}
    </p>
  );
}
