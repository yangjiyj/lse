import { forwardRef } from 'react';
import type { TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'flex min-h-[80px] w-full rounded-[10px] border border-line-2 bg-white px-3 py-2 text-sm transition-colors placeholder:text-slate-400 hover:border-brand-400/70 focus:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-70',
      className,
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';
