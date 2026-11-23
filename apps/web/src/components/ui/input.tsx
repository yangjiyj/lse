import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'flex h-10 w-full rounded-[10px] border border-line-2 bg-white px-3 py-1 text-sm transition-colors placeholder:text-slate-400 hover:border-brand-400/70 focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-70 [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-60 [&::-webkit-calendar-picker-indicator]:hover:opacity-100 [&::-webkit-datetime-edit]:p-0 [&::-webkit-date-and-time-value]:min-h-0 [&::-webkit-date-and-time-value]:text-left [&:is([type=date],[type=datetime-local],[type=month],[type=time])]:text-ink',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
