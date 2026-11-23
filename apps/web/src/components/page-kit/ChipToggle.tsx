import type { ButtonHTMLAttributes } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ChipToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  selected: boolean;
  onToggle: () => void;
}

/** 可开关的筛选/章节胶囊：选中为浅蓝底 + 蓝描边 + 对勾，未选中为白底；语义为 aria-pressed 按钮。 */
export function ChipToggle({ selected, onToggle, className, children, ...props }: ChipToggleProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onToggle}
      className={cn(
        'inline-flex h-8 items-center gap-1 rounded-full border px-3 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected
          ? 'border-brand-600 bg-brand-50 font-semibold text-brand-700'
          : 'border-line-2 bg-white text-ink-2 hover:border-brand-400 hover:text-ink',
        className,
      )}
      {...props}
    >
      {selected ? <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
