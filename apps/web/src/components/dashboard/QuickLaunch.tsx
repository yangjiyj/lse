import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Card } from '@/components/ui/card';
import { QUICK_ENTRIES } from '../../pages/dashboard/ReadinessSection';

const TILE: Record<string, string> = {
  多轮对抗演练: 'from-brand-500 to-brand-600',
  内容安全评估: 'from-[#1FA37A] to-[#12805F]',
  合规专项检测: 'from-[#8B7BEA] to-[#6A55D6]',
  'AI 组件漏洞扫描': 'from-[#F59A4B] to-[#E26F1B]',
};

/** 快速发起：沿用原有入口、路由与写权限判断。无任何可用入口时不渲染。 */
export function QuickLaunch({ className }: { className?: string }) {
  const { hasPermission } = useAuth();
  const entries = QUICK_ENTRIES.filter((e) => hasPermission(e.permission));
  if (entries.length === 0) return null;
  return (
    <Card className={`p-5 ${className ?? ''}`}>
      <h2 className="mb-3 text-[16px] font-bold leading-6 text-ink">快速发起</h2>
      <nav aria-label="检测入口" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {entries.map(({ to, label, hint, icon: Icon }) => (
          <Link
            key={label}
            to={to}
            aria-label={label}
            className="group flex min-w-0 flex-col rounded-xl border border-line bg-gradient-to-b from-white to-canvas/70 p-4 transition-all hover:-translate-y-0.5 hover:border-brand-400 hover:shadow-md"
          >
            <span
              className={`grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br text-white shadow-sm ${TILE[label] ?? 'from-brand-500 to-brand-600'}`}
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="mt-3 text-[14.5px] font-semibold text-ink" aria-hidden="true">
              {label}
            </span>
            <span
              className="mt-1 line-clamp-2 min-h-[36px] text-xs leading-[18px] text-ink-3"
              aria-hidden="true"
            >
              {hint}
            </span>
            <span
              className="mt-2 inline-flex items-center gap-1 text-[13px] font-semibold text-brand-600 group-hover:text-brand-700"
              aria-hidden="true"
            >
              发起
              <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </span>
          </Link>
        ))}
      </nav>
    </Card>
  );
}
