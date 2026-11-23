import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-line-2 bg-white/70 px-4 py-12 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-full bg-brand-50 text-brand-500">
        {icon ?? <Inbox className="h-7 w-7" />}
      </div>
      <div className="space-y-1">
        <p className="text-[15px] font-semibold text-ink">{title}</p>
        {description && <p className="text-sm leading-6 text-ink-3">{description}</p>}
      </div>
      {action}
    </div>
  );
}
