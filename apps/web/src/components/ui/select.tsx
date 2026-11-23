import { forwardRef } from 'react';
import type { CSSProperties, SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** 右侧 chevron（内联 SVG，色值 #5B6778）。用内联 style 而非 Tailwind 任意值，避免 data-URI 转义问题。 */
const CHEVRON_STYLE: CSSProperties = {
  backgroundImage:
    'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%235B6778%27 stroke-width=%272%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27m6 9 6 6 6-6%27/%3E%3C/svg%3E")',
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 0.75rem center',
  backgroundSize: '1rem 1rem',
};

/**
 * 保持原生 <select>（props/ref/aria 全部透传），仅统一外观：
 * appearance-none + 右侧 chevron，高度/圆角/边框/聚焦环与 Input 一致。
 */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, style, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'flex h-10 w-full appearance-none rounded-[10px] border border-line-2 bg-white py-1 pl-3 pr-9 text-sm text-ink transition-colors hover:border-brand-400/70 focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-70',
        className,
      )}
      style={{ ...CHEVRON_STYLE, ...style }}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = 'Select';
