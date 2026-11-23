import { useQuery } from '@tanstack/react-query';
import { aiComponentsApi, ApiError, type AiComponentCompareItem } from '@/lib/api';
import { severityLabel } from '@/lib/format';
import { LoadingBlock } from '@/components/ui/spinner';
import { SEVERITY_TEXT } from './labels';
import { ToolChangeDiff } from './ToolChangeDiff';

function Section({
  title,
  items,
  empty,
  withToolDiff,
}: {
  title: string;
  items: AiComponentCompareItem[];
  empty: string;
  withToolDiff?: boolean;
}) {
  return (
    <div>
      <div className="mb-1 text-sm font-medium text-slate-800">
        {title}（{items.length}）
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-slate-500">{empty}</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {items.map((i) => (
            <li key={i.id} className="rounded-lg bg-slate-50 px-2 py-1">
              <span className={`mr-2 ${SEVERITY_TEXT[i.severity] ?? ''}`}>
                {severityLabel(i.severity)}
              </span>
              <span className="text-slate-800">{i.title}</span>
              <span className="ml-2 text-slate-500">
                {i.filePath ?? ''}
                {i.line ? `:${i.line}` : ''}
              </span>
              {withToolDiff && i.toolChange ? (
                <div className="mt-2">
                  <ToolChangeDiff baseline={i.toolChange.baseline} current={i.toolChange.current} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CompareView({ base, target }: { base: string; target: string }) {
  const q = useQuery({
    queryKey: ['ai-components', 'compare', base, target],
    queryFn: () => aiComponentsApi.compare(base, target),
  });
  if (q.isLoading) return <LoadingBlock />;
  if (q.error)
    return (
      <p className="text-sm text-severity-critical">
        {q.error instanceof ApiError ? q.error.message : '对比失败'}
      </p>
    );
  const d = q.data!;
  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">
        未变化 {d.unchanged} 条。按发现项指纹比对（忽略行号变化）。
      </p>
      <Section title="新增风险" items={d.added} empty="没有新增风险。" />
      <Section title="已消除" items={d.removed} empty="没有被消除的风险。" />
      <Section
        title="工具描述变化"
        items={d.descriptionChanged}
        empty="工具描述与基线一致。"
        withToolDiff
      />
    </div>
  );
}
