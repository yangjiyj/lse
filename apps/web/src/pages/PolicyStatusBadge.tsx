import { Badge } from '@/components/ui/badge';
import type { BadgeTone } from '@/lib/format';
import { POLICY_STATUS_LABELS } from './policy-format';

const TONE: Record<string, BadgeTone> = {
  PUBLISHED: 'success',
  REJECTED: 'critical',
  GATEWAY_REJECTED: 'critical',
  GATEWAY_PENDING: 'warning',
  DISPATCHED: 'info',
  ACCEPTED: 'info',
  MODIFIED: 'info',
  DRAFT: 'neutral',
};

/** 策略建议状态徽章：成功/驳回/待审批/进行中/草稿，颜色 + 形状 + 文字三重编码。 */
export function PolicyStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={TONE[status] ?? 'neutral'} icon>
      {POLICY_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}
