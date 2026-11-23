import { Badge } from './badge';
import { SEVERITY_LABELS, SEVERITY_TONE } from '@/lib/format';
import type { BadgeTone } from '@/lib/format';

/**
 * 严重度徽章：颜色 + 形状图标 + 文字三重编码。
 * 严重 ◆ / 高危 ▲ / 中危 ● / 低危 ○ / 通过 ✓ / 未判定 —，黑白打印仍可辨。
 */
export function SeverityBadge({ value }: { value: string | null | undefined }) {
  let label: string;
  let tone: BadgeTone;
  if (value && value in SEVERITY_LABELS) {
    label = SEVERITY_LABELS[value as keyof typeof SEVERITY_LABELS];
    tone = SEVERITY_TONE[value as keyof typeof SEVERITY_TONE];
  } else if (value === 'PASS') {
    label = '通过';
    tone = 'success';
  } else {
    label = value ?? '—';
    tone = 'neutral';
  }
  return (
    <Badge tone={tone} icon>
      {label}
    </Badge>
  );
}
