import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import type { BadgeTone } from '@/lib/format';
import { cn } from '@/lib/utils';

interface TagClusterProps {
  tags: string[];
  /** 直接展示的最大数量，其余折叠为「+N」，悬停/聚焦展开。 */
  max?: number;
  tone?: BadgeTone;
  className?: string;
  /** 无标签时的占位。 */
  empty?: ReactNode;
}

/** 标签组：最多显示 max 个，其余收进「+N」悬停展开，避免一整排密集标签。 */
export function TagCluster({
  tags,
  max = 3,
  tone = 'success',
  className,
  empty = null,
}: TagClusterProps) {
  if (tags.length === 0) return <>{empty}</>;
  const shown = tags.slice(0, max);
  const rest = tags.slice(max);
  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {shown.map((tag) => (
        <Badge key={tag} tone={tone} className="max-w-full truncate" title={tag}>
          {tag}
        </Badge>
      ))}
      {rest.length > 0 && (
        <span className="group relative inline-flex">
          <button
            type="button"
            aria-label={`另有 ${rest.length} 项：${rest.join('、')}`}
            className="inline-flex h-5 items-center rounded-md bg-slate-100 px-1.5 text-xs font-semibold text-ink-2 ring-1 ring-inset ring-black/5 hover:bg-brand-50 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            +{rest.length}
          </button>
          <span
            role="tooltip"
            className="pointer-events-none absolute left-0 top-full z-30 mt-1 hidden w-max max-w-[16rem] flex-col gap-1 rounded-xl border border-line bg-white p-2 shadow-pop group-focus-within:flex group-hover:flex"
          >
            {rest.map((tag) => (
              <Badge key={tag} tone={tone} className="whitespace-normal">
                {tag}
              </Badge>
            ))}
          </span>
        </span>
      )}
    </div>
  );
}
