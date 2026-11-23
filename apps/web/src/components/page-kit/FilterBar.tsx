import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** 列表筛选条：统一的浅底圆角容器，子项自动换行对齐。 */
export function FilterBar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'mb-4 flex flex-wrap items-center gap-2.5 rounded-xl border border-line bg-[#F7F9FD] px-3 py-2.5',
        className,
      )}
      {...props}
    />
  );
}
