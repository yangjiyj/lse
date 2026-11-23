import { cn } from '@/lib/utils';

export interface SegmentTabItem<T extends string> {
  value: T;
  label: string;
}

interface SegmentTabsProps<T extends string> {
  items: Array<SegmentTabItem<T>>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  /** sm 用于页内二级切换；field 放在筛选条里，和下拉、输入框一样高、一样的边框。 */
  size?: 'md' | 'sm' | 'field';
  className?: string;
}

/** 分段页签：圆角底槽 + 选中白底浮起，语义为 tablist / tab。 */
export function SegmentTabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  size = 'md',
  className,
}: SegmentTabsProps<T>) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex gap-1 rounded-xl bg-[#E9EEF6] p-1',
        size === 'field' && 'h-10 gap-0 rounded-[10px] border border-line-2 p-0',
        className,
      )}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.value)}
            className={cn(
              'whitespace-nowrap rounded-[9px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              size === 'md'
                ? 'h-9 px-4 text-[13.5px]'
                : size === 'field'
                  ? 'h-full px-3 text-[13px]'
                  : 'h-8 px-3 text-[13px]',
              active
                ? 'bg-white font-semibold text-brand-700 shadow-card'
                : 'text-ink-2 hover:text-ink',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
