import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * 题库覆盖页顶部：当前题库版本。题库随产品版本发布，更新周期、立即更新、更新记录不在页面上显示。
 */
export function BankVersionInfo() {
  const query = useQuery({
    queryKey: ['question-sets', 'bank-updates'],
    queryFn: () => api.questionSets.bankUpdates(),
    retry: false,
  });
  const version = query.data?.questions.version;
  if (!version) return null;
  return <div className="text-[14px] font-semibold text-ink">题库版本 {version}</div>;
}
