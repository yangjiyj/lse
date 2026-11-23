import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type QuestionSet } from '@/lib/api';
import { SegmentTabs } from '@/components/page-kit/SegmentTabs';
import { NoteBox } from '@/components/page-kit/NoteBox';
import { LoadingBlock } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { BuiltinBankPanel } from './BuiltinBankPanel';
import { BankCoveragePanel } from './BankCoveragePanel';
import { SeedBankCard } from './SeedBankCard';
import { SEED_BANK_GROUPS, gbtBankOrder, seedBankGroup } from './seed-bank-meta';

/** 「种子库」页签：平台内置的评估题源。总览看卡片，「GB/T 45654-2025 附录 A」页签保留原内置题库的大类/小类浏览。 */
export function SeedBankTab({
  onView,
  renderActions,
}: {
  onView?: (set: QuestionSet) => void;
  renderActions?: (set: QuestionSet) => ReactNode;
}) {
  const [sub, setSub] = useState<'overview' | 'tree' | 'gbt'>('overview');
  const list = useQuery({
    queryKey: ['question-sets', 'seed-list'],
    queryFn: () => api.questionSets.list({ kind: 'seed', pageSize: 100 }),
  });
  return (
    <div className="space-y-4">
      <NoteBox tone="info">
        种子库是平台自带、只读的评估题源，创建评估任务时可直接选用；需要修改请先「复制为自有题库」。
      </NoteBox>
      <SegmentTabs
        size="sm"
        ariaLabel="种子库视图"
        value={sub}
        onChange={setSub}
        items={[
          { value: 'overview', label: '库总览' },
          { value: 'tree', label: 'GB/T 45654-2025 附录 A' },
          { value: 'gbt', label: '国标题库覆盖' },
        ]}
      />
      {sub === 'gbt' ? (
        <BankCoveragePanel />
      ) : sub === 'tree' ? (
        <BuiltinBankPanel />
      ) : list.isLoading ? (
        <LoadingBlock />
      ) : !list.data || list.data.items.length === 0 ? (
        <EmptyState
          title="暂无种子库"
          description="内置种子库尚未初始化，请执行数据库 seed 后刷新。"
        />
      ) : (
        <div className="space-y-6">
          {SEED_BANK_GROUPS.map((g) => {
            const sets = list.data.items
              .filter((s) => seedBankGroup(s.source) === g.id)
              .sort((a, b) =>
                g.id === 'gbt' ? gbtBankOrder(a.source) - gbtBankOrder(b.source) : 0,
              );
            if (sets.length === 0) return null;
            return (
              <section key={g.id} aria-labelledby={`seed-group-${g.id}`} className="space-y-3">
                <h2 id={`seed-group-${g.id}`} className="text-[15px] font-semibold text-ink">
                  {g.title}
                </h2>
                <div
                  className={`grid gap-4 lg:grid-cols-2${g.id === 'gbt' ? ' xl:grid-cols-3' : ''}`}
                >
                  {sets.map((s) => (
                    <SeedBankCard
                      key={s.id}
                      set={s}
                      onView={onView ? () => onView(s) : undefined}
                      actions={renderActions?.(s)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
