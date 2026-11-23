import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface SectionCardProps {
  title: ReactNode;
  /** 标题下一行辅助说明（保持一行内的短句） */
  description?: ReactNode;
  /** 标题行右侧的操作 / 搜索框 */
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

/** 页面区块：卡片 + 16px 标题 + 辅助说明 + 右侧操作，统一各专项页的区块层次。 */
export function SectionCard({
  title,
  description,
  extra,
  children,
  className,
  bodyClassName,
}: SectionCardProps) {
  return (
    <Card className={cn('min-w-0', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-6 py-4">
        <div className="min-w-0">
          <h2 className="text-[16px] font-bold leading-tight text-ink">{title}</h2>
          {description && <p className="mt-1 text-[13px] leading-5 text-ink-3">{description}</p>}
        </div>
        {extra && <div className="flex shrink-0 flex-wrap items-center gap-2">{extra}</div>}
      </div>
      <div className={cn('p-6', bodyClassName)}>{children}</div>
    </Card>
  );
}

/** 页首一句话说明条：白底细边，不抢标题层级。 */
export function NoteBar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        'rounded-card border border-line bg-white px-5 py-3 text-[13.5px] leading-6 text-ink-2 shadow-card',
        className,
      )}
    >
      {children}
    </p>
  );
}
