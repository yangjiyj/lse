const LABELS: Record<string, string> = {
  not_executed: '前提不满足，未执行',
  blackbox_reached: '黑盒可达',
  inconclusive: '已调用，判定不明确',
  unreachable: '不可达或证据不足',
};
export function ReachabilityBadge({ value }: { value?: string }) {
  const label = value ? (LABELS[value] ?? '未统计') : '未统计';
  return (
    <span className="block text-xs text-muted-foreground" aria-label="可达性">
      {label}
    </span>
  );
}
