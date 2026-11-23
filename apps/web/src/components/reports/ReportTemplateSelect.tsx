import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';

/**
 * 报告模板选择（2.4.7）。空值表示不指定：生成时不快照模板；下载时按生成时的模板，没有则用本租户默认模板。
 * 租户里没有模板时不显示。全部租户视角下传 tenantId，只列该租户的模板。
 */
export function ReportTemplateSelect({
  id,
  value,
  onChange,
  emptyLabel = '默认模板',
  tenantId,
  className,
}: {
  id?: string;
  value: string;
  onChange: (templateId: string) => void;
  /** 空选项的文字：下载时是「按生成时」，生成时是「默认模板」 */
  emptyLabel?: string;
  tenantId?: string | null;
  className?: string;
}) {
  const templates = useQuery({
    queryKey: ['report-templates', tenantId ?? null],
    queryFn: () => api.reportTemplates.list(tenantId ? { tenantId } : undefined),
    staleTime: 60 * 1000,
  });
  const items = templates.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <Select
      id={id}
      aria-label="报告模板"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn('w-auto min-w-[10rem]', className)}
    >
      <option value="">{emptyLabel}</option>
      {items.map((t) => (
        <option key={t.id} value={t.id}>
          {t.isDefault ? `${t.name}（默认）` : t.name}
        </option>
      ))}
    </Select>
  );
}
