import type {
  AssuranceImpactStatus,
  AssurancePriority,
  ServiceAssuranceAssessmentItem,
  ServiceAssuranceRunDetailResponse,
} from '@lse/shared';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  PackageSearch,
  RotateCcw,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { SeverityBadge } from '@/components/ui/status-badge';
import type { BadgeTone } from '@/lib/format';

const IMPACT_META: Record<
  AssuranceImpactStatus,
  { label: string; tone: BadgeTone; icon: typeof AlertTriangle }
> = {
  AFFECTED: { label: '已确认', tone: 'critical', icon: AlertTriangle },
  UNDER_INVESTIGATION: { label: '待核验', tone: 'warning', icon: CircleHelp },
  NOT_AFFECTED: { label: '不受影响', tone: 'success', icon: ShieldCheck },
  FIXED: { label: '已修复', tone: 'info', icon: CheckCircle2 },
};

const PRIORITY_LABEL: Record<AssurancePriority, string> = {
  P0: 'P0',
  P1: 'P1',
  P2: 'P2',
  P3: 'P3',
  UNKNOWN: '待评估',
};

function confidenceLabel(value: number | null): string {
  return value === null ? '可信度待评估' : `可信度 ${Math.round(value * 100)}%`;
}

function impactDescription(item: ServiceAssuranceAssessmentItem): string {
  if (item.impactStatus === 'AFFECTED') {
    return '现有证据表明目标在本次核验范围内受影响，需结合业务暴露面评估实际后果。';
  }
  if (item.impactStatus === 'UNDER_INVESTIGATION') {
    return '现有证据不足，不能据此确认存在对应漏洞或配置风险。';
  }
  if (item.impactStatus === 'NOT_AFFECTED') {
    return '当前证据支持不受影响结论，判断依据应随服务变更持续复核。';
  }
  return '原风险已经完成整改复测，历史影响与前后证据继续保留。';
}

interface AssuranceResultListProps {
  detail: ServiceAssuranceRunDetailResponse | null;
  canReview: boolean;
  canRetest: boolean;
  onOpenEvidence: () => void;
  onReview: (assessment: ServiceAssuranceAssessmentItem) => void;
  onRetest: (assessment: ServiceAssuranceAssessmentItem) => void;
}

export function AssuranceResultList({
  detail,
  canReview,
  canRetest,
  onOpenEvidence,
  onReview,
  onRetest,
}: AssuranceResultListProps) {
  if (!detail) {
    return (
      <EmptyState
        icon={<PackageSearch className="h-6 w-6" />}
        title="暂无核验结果"
        description="选择最近运行后查看服务、组件和结论。"
      />
    );
  }

  return (
    <section className="min-w-0 space-y-4" aria-labelledby="assurance-results-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 id="assurance-results-title" className="text-sm font-semibold text-ink">
            服务与核验结论
          </h2>
          <p className="mt-1 text-[13px] text-ink-3">
            先查看风险与整改建议，判定详情和技术证据可展开查看。
          </p>
        </div>
        {canReview && (
          <Button type="button" variant="outline" size="sm" onClick={onOpenEvidence}>
            查看技术证据
            <ChevronRight className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div className="space-y-3">
        {detail.assets.map((asset) => (
          <div
            key={asset.assetId}
            className="min-w-0 rounded-md border border-line bg-white px-4 py-3 shadow-sm"
          >
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-ink-3">
                <Server className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <h3 className="break-words text-sm font-semibold text-ink">{asset.name}</h3>
                <p className="mt-1 break-all text-xs leading-5 text-ink-3">{asset.address}</p>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
                  {asset.title && <span>{asset.title}</span>}
                  {asset.protocol && <span>{asset.protocol.toUpperCase()}</span>}
                  {asset.port && <span>端口 {asset.port}</span>}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {detail.components.length > 0 && (
        <div className="grid min-w-0 gap-2 md:grid-cols-2">
          {detail.components.map((component) => {
            const lead = !component.version || component.evidenceLabel === '待核验线索';
            return (
              <div
                key={component.componentId}
                className="min-w-0 rounded-md border border-line bg-canvas px-3 py-3"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="min-w-0 break-words text-sm font-semibold text-ink">
                    {component.name}
                  </span>
                  {lead && <Badge tone="warning">疑似组件</Badge>}
                </div>
                <div className="mt-2 flex min-w-0 flex-wrap gap-2 text-xs text-ink-3">
                  <Badge tone={lead ? 'warning' : 'info'}>{component.evidenceLabel}</Badge>
                  <span>{component.version ? `版本 ${component.version}` : '版本待确认'}</span>
                  <span>{confidenceLabel(component.confidence)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {detail.results.length === 0 && (
        <div className="rounded-md border border-line bg-white p-4 text-sm leading-6 text-ink-2">
          本次尚无风险结论。请结合上方检查项目和覆盖限制判断；零条风险记录不等于已经证明安全。
        </div>
      )}
      <div className="space-y-3">
        {detail.results.map((item) => {
          const meta = IMPACT_META[item.impactStatus];
          const Icon = meta.icon;
          const showReviewAction = canReview && item.impactStatus !== 'FIXED';
          const showRetestAction = canRetest && item.impactStatus === 'AFFECTED';
          return (
            <article
              key={item.assessmentId}
              className="min-w-0 overflow-hidden rounded-md border border-line bg-white shadow-sm"
            >
              <div className="flex min-w-0 items-start gap-3 border-b border-slate-100 px-4 py-4">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-100 text-ink-2">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="break-words text-sm font-semibold leading-6 text-ink">
                    {item.title}
                  </h3>
                  <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                    {item.severity ? (
                      <SeverityBadge value={item.severity} />
                    ) : (
                      <Badge tone="neutral">严重度未知</Badge>
                    )}
                  </div>
                </div>
              </div>
              <div className="grid min-w-0 gap-4 px-4 py-4 lg:grid-cols-2">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-ink-3">判断依据</div>
                  <p className="mt-1 break-words text-sm leading-6 text-ink">{item.reason}</p>
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-ink-3">整改建议</div>
                  <p className="mt-1 break-words text-sm leading-6 text-ink">
                    {item.remediation ??
                      (item.impactStatus === 'UNDER_INVESTIGATION'
                        ? '先补齐组件版本或授权验证证据，再判断是否需要整改。'
                        : '按复核结论保持当前控制并持续监测。')}
                  </p>
                </div>
              </div>
              <details className="border-t border-slate-100 px-4 py-3 text-xs text-ink-3">
                <summary className="cursor-pointer font-medium">判定详情</summary>
                <p className="mt-2 leading-6">{impactDescription(item)}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <span>{confidenceLabel(item.confidence)}</span>
                  <span>整改优先级 {PRIORITY_LABEL[item.priority]}</span>
                  <span>{item.evidenceLabel}</span>
                </div>
              </details>
              {showReviewAction || showRetestAction ? (
                <div className="flex min-w-0 flex-wrap justify-end gap-2 border-t border-slate-100 bg-canvas px-4 py-3">
                  {showReviewAction && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onReview(item)}
                    >
                      <ClipboardCheck className="h-4 w-4" />
                      复核结论
                    </Button>
                  )}
                  {showRetestAction && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onRetest(item)}
                    >
                      <RotateCcw className="h-4 w-4" />
                      发起复测
                    </Button>
                  )}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
