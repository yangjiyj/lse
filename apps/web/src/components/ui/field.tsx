import type { ReactNode } from 'react';
import { Label } from './label';
import { cn } from '@/lib/utils';

interface FieldProps {
  label: ReactNode;
  htmlFor?: string;
  required?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function Field({ label, htmlFor, required, hint, error, className, children }: FieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {required && (
          <span aria-hidden="true" className="ml-0.5 text-destructive">
            *
          </span>
        )}
      </Label>
      {children}
      {hint && !error && <p className="mt-0.5 text-xs leading-5 text-ink-3">{hint}</p>}
      {error && <p className="mt-0.5 text-xs leading-5 text-destructive">{error}</p>}
    </div>
  );
}
