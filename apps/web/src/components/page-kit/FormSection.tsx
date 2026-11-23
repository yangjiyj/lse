import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface FormSectionProps {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  /** 字段列数：默认 2 列（窄屏 1 列），设为 1 则整行铺开。 */
  columns?: 1 | 2;
}

/** 弹窗内的分区卡片：标题 + 说明 + 字段区，字段间距统一 16px。 */
export function FormSection({
  title,
  description,
  children,
  className,
  columns = 2,
}: FormSectionProps) {
  return (
    <section className={cn('rounded-2xl border border-line bg-[#FAFBFE] p-4', className)}>
      <header className="mb-3">
        <h3 className="text-[14px] font-bold text-ink">{title}</h3>
        {description && <p className="mt-0.5 text-xs leading-5 text-ink-3">{description}</p>}
      </header>
      <div className={cn('grid grid-cols-1 gap-4', columns === 2 && 'sm:grid-cols-2')}>
        {children}
      </div>
    </section>
  );
}
