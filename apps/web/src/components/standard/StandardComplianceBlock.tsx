import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { LoadingBlock } from '@/components/ui/spinner';
import { StandardComplianceSection } from '@/components/standard/StandardComplianceSection';
import { GbtMethodsSection } from '@/components/standard/GbtMethodsSection';

/**
 * 任务详情里的国标区块：按附录 B 方法抽样的运行显示各方法进度与结论，
 * 旧版运行（四组指标）仍显示原来的区块。
 */
export function StandardComplianceBlock({ runId }: { runId: string }) {
  const probe = useQuery({
    queryKey: ['gbt-state', runId],
    queryFn: () => api.standardEvaluations.gbtState(runId),
    retry: false,
    // 旧版运行会返回「不是按附录 B 方法抽样」的 400，不重试也不轮询。
    refetchInterval: false,
  });
  if (probe.isLoading) return <LoadingBlock label="正在加载国标评估…" />;
  if (probe.data) return <GbtMethodsSection runId={runId} />;
  return <StandardComplianceSection runId={runId} />;
}
