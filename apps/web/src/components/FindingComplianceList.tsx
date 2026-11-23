import type { EvalResultFinding } from '@/lib/api';
import { Badge } from '@/components/ui/badge';

const LEVEL_TONE: Record<string, 'danger' | 'warning' | 'neutral'> = {
  HIGH: 'danger',
  MEDIUM: 'warning',
  LOW: 'neutral',
};

/** 参数7：每条发现的风险等级（高/中/低）、关联法律法规与评估理由。 */
export function FindingComplianceList({ findings }: { findings: EvalResultFinding[] }) {
  const items = findings.filter((f) => f.compliance && (!f.verdict || f.verdict === 'FAIL'));
  if (items.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted-foreground">风险结论与合规依据</div>
      <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
        {items.map((finding, index) => {
          const c = finding.compliance!;
          return (
            <div
              key={`${finding.engine}-${finding.riskCategory}-${index}`}
              className="rounded-md border border-border bg-background/80 p-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={LEVEL_TONE[c.riskLevel] ?? 'neutral'}>{c.riskLevelLabel}</Badge>
                <Badge tone="neutral">风险类别：{c.complianceCategoryLabel ?? '未归类'}</Badge>
              </div>
              <div className="mt-2">
                <span className="font-medium text-slate-700">关联法律法规：</span>
                {c.legalReferences.length > 0 ? (
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                    {c.legalReferences.map((ref) => (
                      <li key={`${ref.law}-${ref.topic}`}>
                        {ref.law}（{ref.topic}）
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-muted-foreground">该风险类别暂无法规映射</span>
                )}
              </div>
              <div className="mt-2 break-words text-muted-foreground [overflow-wrap:anywhere]">
                <span className="font-medium text-slate-700">评估理由：</span>
                {finding.evidence || finding.reviewReason || '引擎未返回评估理由'}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
