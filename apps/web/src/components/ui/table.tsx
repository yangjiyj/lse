import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

interface TableProps extends HTMLAttributes<HTMLTableElement> {
  fit?: boolean;
}

const responsiveCardTableClass =
  'max-md:block max-md:[&_tbody]:block max-md:[&_thead]:hidden max-md:[&_tr]:block max-md:[&_tr]:border-b max-md:[&_tr]:border-line max-md:[&_tr]:p-3 max-md:[&_tr]:last:border-b-0 max-md:[&_td]:flex max-md:[&_td]:items-start max-md:[&_td]:justify-between max-md:[&_td]:gap-4 max-md:[&_td]:border-0 max-md:[&_td]:px-0 max-md:[&_td]:py-2 max-md:[&_td]:text-left max-md:[&_td]:before:mr-3 max-md:[&_td]:before:min-w-20 max-md:[&_td]:before:shrink-0 max-md:[&_td]:before:text-left max-md:[&_td]:before:text-xs max-md:[&_td]:before:font-semibold max-md:[&_td]:before:text-slate-500 max-md:[&_td]:before:content-[attr(data-label)]';

export function Table({ className, fit = false, ...props }: TableProps) {
  return (
    // min-w-0：作为 grid / flex 子项时，容器不被表格的最小宽度撑破，而是在自身内横向滚动
    //（否则 xl:grid-cols-2 下第二列会被挤出视口，见任务对比页）。
    // 窄屏（<md）表格改为卡片行，不需要滚动，继续 overflow-hidden 保持圆角裁切。
    <div className="w-full min-w-0 max-w-full overflow-hidden rounded-[14px] border border-line bg-white md:overflow-x-auto md:scrollbar-thin">
      <table
        className={cn(
          'w-full caption-bottom text-sm tabular-nums',
          fit ? 'table-fixed md:min-w-0' : 'md:min-w-[720px]',
          responsiveCardTableClass,
          className,
        )}
        {...props}
      />
    </div>
  );
}
export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('border-b border-line bg-[#F7F9FD]', className)} {...props} />;
}
export function TBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('divide-y divide-[#EEF2F8]', className)} {...props} />;
}
export function TR({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('transition-colors hover:bg-brand-50/50', className)} {...props} />;
}
export function TH({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'h-11 whitespace-nowrap bg-[#F7F9FD] px-3 text-left align-middle text-[13px] font-semibold text-ink-3',
        className,
      )}
      {...props}
    />
  );
}
export function TD({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn('h-12 px-3 align-middle text-[13.5px] text-ink', className)} {...props} />
  );
}
