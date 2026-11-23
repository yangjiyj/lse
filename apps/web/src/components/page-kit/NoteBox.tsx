import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

interface NoteBoxProps extends HTMLAttributes<HTMLDivElement> {
  tone?: 'info' | 'warning' | 'neutral';
}

const TONE = {
  info: 'border-brand-100 bg-brand-50/70 text-ink-2',
  warning: 'border-[#F3DFA2] bg-severity-medium-bg text-severity-medium',
  neutral: 'border-line bg-[#F7F9FD] text-ink-2',
} as const;

/** 说明/提示条：统一圆角、底色与字号，三种语气。 */
export function NoteBox({ tone = 'neutral', className, ...props }: NoteBoxProps) {
  return (
    <div
      className={cn('rounded-xl border px-4 py-3 text-[13px] leading-6', TONE[tone], className)}
      {...props}
    />
  );
}
