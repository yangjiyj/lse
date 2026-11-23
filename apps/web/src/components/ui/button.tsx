import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/** 按钮样式（链接要做成按钮外观时复用，如 <Link className={buttonVariants(...)} />）。 */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[10px] text-[13.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary:
          'bg-gradient-to-b from-brand-500 to-brand-600 font-semibold text-primary-foreground shadow-btn hover:from-brand-600 hover:to-brand-700',
        secondary: 'bg-[#EEF2F8] text-ink hover:bg-line',
        outline:
          'border border-line-2 bg-white text-ink hover:border-brand-400 hover:text-brand-700',
        ghost: 'text-ink-2 hover:bg-slate-100 hover:text-ink',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
      },
      size: {
        sm: 'h-8 rounded-[9px] px-3 text-[13px]',
        md: 'h-9 px-4',
        lg: 'h-11 px-6 text-[14px]',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = 'Button';
