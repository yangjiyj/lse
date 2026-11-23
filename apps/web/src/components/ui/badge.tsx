import type { HTMLAttributes } from 'react';
import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BADGE_TONE_CLASS, type BadgeTone } from '@/lib/format';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** 在文字前加形状图标（颜色 + 形状 + 文字三重编码，黑白打印可辨）。 */
  icon?: boolean;
}

/** 语义形状：严重 ◆ / 高危 ▲ / 中危 ● / 低危 ○ / 通过 ✓ / 未判定 —，彼此形状互异。 */
export function ToneShape({ tone, className }: { tone: BadgeTone; className?: string }) {
  const common = {
    'aria-hidden': true,
    className: cn('h-3 w-3 shrink-0', className),
    viewBox: '0 0 12 12',
  } as const;
  switch (tone) {
    case 'critical':
      return (
        <svg {...common}>
          <path d="M6 1 L11 6 L6 11 L1 6 Z" fill="currentColor" />
        </svg>
      );
    case 'danger':
      return (
        <svg {...common}>
          <path d="M6 1.5 L11 10.5 H1 Z" fill="currentColor" />
        </svg>
      );
    case 'warning':
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.2" fill="currentColor" />
        </svg>
      );
    case 'info':
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="3.8" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      );
    case 'success':
      return (
        <Check aria-hidden="true" strokeWidth={3} className={cn('h-3 w-3 shrink-0', className)} />
      );
    default:
      return (
        <Minus aria-hidden="true" strokeWidth={3} className={cn('h-3 w-3 shrink-0', className)} />
      );
  }
}

export function Badge({
  className,
  tone = 'neutral',
  icon = false,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-px text-xs font-semibold leading-5 ring-1 ring-inset',
        BADGE_TONE_CLASS[tone],
        className,
      )}
      {...props}
    >
      {icon && <ToneShape tone={tone} />}
      {children}
    </span>
  );
}
