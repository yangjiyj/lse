import { Link } from 'react-router-dom';
import { ScanSearch, ShieldCheck } from 'lucide-react';
import type { ComponentSecurityStats } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { DashCard, type CardLoadState } from './DashCard';
import { fmt } from './utils';

export function ComponentSecurityCard({
  data,
  state,
  className,
}: {
  data?: ComponentSecurityStats;
  state: CardLoadState;
  className?: string;
}) {
  const { hasPermission } = useAuth();
  const canScan = hasPermission('engine:scan');
  const hasVuln = !!data && data.vulnerabilityCount > 0;
  const scanned = !!data && (data.componentCount > 0 || data.runCount > 0);
  return (
    <DashCard
      title="AI 组件安全"
      state={state}
      skeletonRows={4}
      className={className}
      action={
        hasVuln ? (
          <Link
            to="/service-assurance"
            className="text-[13px] font-medium text-brand-600 hover:text-brand-700"
          >
            查看详情 ›
          </Link>
        ) : undefined
      }
    >
      {!data ? null : hasVuln ? (
        <div>
          <div className="font-num text-[40px] font-bold leading-[44px] tabular-nums text-severity-high">
            {fmt(data.vulnerabilityCount)}
            <span className="ml-2 font-sans text-[13px] font-normal text-ink-3">项组件漏洞</span>
          </div>
          <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
            {[
              ['AI 组件', data.componentCount],
              ['基线问题', data.baselineIssueCount],
              ['扫描次数', data.runCount],
            ].map(([label, v]) => (
              <div key={label as string} className="rounded-xl bg-canvas px-2 py-2.5">
                <dd className="font-num text-[20px] font-bold tabular-nums text-ink">
                  {fmt(v as number)}
                </dd>
                <dt className="text-xs text-ink-3">{label}</dt>
              </div>
            ))}
          </dl>
        </div>
      ) : (
        <div className="flex h-full min-h-[190px] flex-col items-center justify-center gap-2 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-full bg-brand-50 text-brand-600 ring-4 ring-brand-50/60">
            {scanned ? (
              <ShieldCheck className="h-7 w-7" aria-hidden="true" />
            ) : (
              <ScanSearch className="h-7 w-7" aria-hidden="true" />
            )}
          </span>
          <div className="text-[15px] font-semibold text-ink">
            {scanned ? '暂未发现组件漏洞' : '尚未扫描 AI 组件'}
          </div>
          <p className="max-w-[260px] text-[13px] leading-5 text-ink-3">
            {scanned
              ? `已纳管 ${fmt(data.componentCount)} 个组件，漏洞 0 项。`
              : '漏洞 0 项。上传模型文件或组件清单即可开始扫描。'}
          </p>
          {canScan && (
            <Link
              to="/ai-asset-scan"
              className="mt-1 inline-flex h-8 items-center rounded-[9px] bg-brand-50 px-4 text-[13px] font-semibold text-brand-700 hover:bg-brand-100"
            >
              {scanned ? '再次扫描' : '开始扫描'}
            </Link>
          )}
        </div>
      )}
    </DashCard>
  );
}
