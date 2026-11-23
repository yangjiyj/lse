import type { ServiceAssuranceCustomerSummary } from '@lse/shared';
import { AlertCircle, CheckCircle2, Search, ShieldCheck } from 'lucide-react';

interface AssuranceSummaryProps {
  summary: ServiceAssuranceCustomerSummary | null;
}

export function AssuranceSummary({ summary }: AssuranceSummaryProps) {
  if (!summary) return null;
  const items = [
    {
      label: '已确认风险',
      value: summary?.confirmed ?? 0,
      icon: AlertCircle,
      className: 'border-red-200 bg-red-50 text-red-800',
    },
    {
      label: '待补充证据',
      value: summary?.underInvestigation ?? 0,
      icon: Search,
      className: 'border-amber-200 bg-amber-50 text-amber-800',
    },
    {
      label: '不受影响',
      value: summary?.notAffected ?? 0,
      icon: ShieldCheck,
      className: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    },
    {
      label: '已修复',
      value: summary?.fixed ?? 0,
      icon: CheckCircle2,
      className: 'border-sky-200 bg-sky-50 text-sky-800',
    },
  ];

  return (
    <div data-testid="assurance-summary" className="grid min-w-0 grid-cols-2 gap-2 xl:grid-cols-4">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <div
            key={item.label}
            className={`min-h-20 min-w-0 rounded-md border px-3 py-3 ${item.className}`}
          >
            <div className="flex items-center gap-2 text-xs font-medium">
              <Icon className="h-4 w-4 shrink-0" />
              <span className="min-w-0 break-words">{item.label}</span>
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{item.value}</div>
          </div>
        );
      })}
    </div>
  );
}
