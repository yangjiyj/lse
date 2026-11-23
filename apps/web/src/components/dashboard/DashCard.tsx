import type { ReactNode } from 'react';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface CardLoadState {
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
}

/** 卡片内骨架：加载中占位，避免布局跳动。 */
export function CardSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('animate-pulse space-y-3', className)} aria-busy="true" aria-label="加载中">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-4 rounded bg-slate-100"
          style={{ width: `${92 - ((i * 17) % 40)}%` }}
        />
      ))}
    </div>
  );
}

/** 局部失败：只影响本卡，给出「加载失败 · 重试」。 */
export function CardError({ onRetry, name }: { onRetry?: () => void; name?: string }) {
  return (
    <div
      role="alert"
      className="flex min-h-[96px] flex-col items-center justify-center gap-2 py-4 text-center"
    >
      <TriangleAlert className="h-5 w-5 text-severity-high" aria-hidden="true" />
      <div className="text-[13px] text-ink-2" aria-label={name ? `${name}加载失败` : undefined}>
        数据暂时无法显示
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-7 items-center gap-1 rounded-lg border border-line-2 bg-white px-2.5 text-xs font-medium text-brand-700 hover:border-brand-400"
        >
          <RefreshCw className="h-3 w-3" aria-hidden="true" />
          加载失败 · 重试
        </button>
      )}
    </div>
  );
}

/** 首页通用卡片：标题 + 右侧操作 + 内容；按 state 自动切换骨架 / 失败态。 */
export function DashCard({
  title,
  badge,
  action,
  state,
  skeletonRows,
  className,
  bodyClassName,
  children,
  ...rest
}: {
  title: string;
  badge?: ReactNode;
  action?: ReactNode;
  state?: CardLoadState;
  skeletonRows?: number;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
} & { 'aria-label'?: string }) {
  return (
    <Card className={cn('flex min-w-0 flex-col p-5', className)} {...rest}>
      <header className="mb-3 flex min-h-[24px] items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-[16px] font-bold leading-6 text-ink">{title}</h2>
          {badge}
        </div>
        {action}
      </header>
      <div className={cn('min-w-0 flex-1', bodyClassName)}>
        {state?.isError ? (
          <CardError onRetry={state.onRetry} name={title} />
        ) : state?.isLoading ? (
          <CardSkeleton rows={skeletonRows} />
        ) : (
          children
        )}
      </div>
    </Card>
  );
}

/** 标题右侧的小标签（如「本月」）。 */
export function ChipTag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-line-2 bg-canvas px-2 py-px text-[11.5px] leading-[18px] text-ink-3">
      {children}
    </span>
  );
}
