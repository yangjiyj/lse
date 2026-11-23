import { SeverityBadge } from '@/components/ui/severity-badge';

const tones: Record<string, string> = {
  CRITICAL: '[&>span]:bg-[#B42318] [&>span]:text-white [&>span]:ring-[#B42318]',
  HIGH: '[&>span]:bg-[#FDECEA] [&>span]:text-[#B42318] [&>span]:ring-transparent',
  MEDIUM: '[&>span]:bg-[#FFF6D6] [&>span]:text-[#8A5F00] [&>span]:ring-transparent',
  LOW: '[&>span]:bg-[#EAF0F6] [&>span]:text-[#4F6B8A] [&>span]:ring-transparent',
};

/** 复用统一等级徽章，在处置台局部对齐公共规约的等级色。 */
export function RiskSeverityBadge({ value }: { value: string | null }) {
  return <span className={`[&>span]:gap-0.5 [&>span]:px-1 ${tones[value ?? ''] ?? ''}`}><SeverityBadge value={value} /></span>;
}
