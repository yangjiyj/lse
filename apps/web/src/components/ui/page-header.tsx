import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
}

/** 页头：26px 粗体标题 + 辅助说明 + 右侧主操作；面包屑由 AppShell 统一渲染在其上方。 */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-[26px] font-bold leading-tight tracking-[0.01em] text-ink">{title}</h1>
        {description && (
          <p className="mt-1 max-w-3xl truncate text-[13.5px] text-ink-3" title={description}>
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
