import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { RuleLibraryStats as RuleLibrary } from '@/lib/api';
import { DashCard, type CardLoadState } from './DashCard';
import { fmt } from './utils';

/** 首页「规则库」统计（2.2.1）：数字可点，跳到对应的库；没有查看权限时只显示数字。 */
export function RuleLibraryCard({
  stats,
  state,
  canReadQuestionSets,
  canReadAgentSamples,
}: {
  stats?: RuleLibrary;
  state: CardLoadState;
  canReadQuestionSets: boolean;
  canReadAgentSamples: boolean;
}) {
  const items: Array<{ key: keyof RuleLibrary; label: string; to: string | null }> = [
    { key: 'questionSets', label: '题集', to: canReadQuestionSets ? '/question-sets' : null },
    { key: 'questions', label: '题目', to: canReadQuestionSets ? '/question-sets' : null },
    {
      key: 'keywords',
      label: '关键词',
      to: canReadQuestionSets ? '/question-sets?tab=keyword' : null,
    },
    {
      key: 'agentSamples',
      label: '智能体样本',
      to: canReadAgentSamples ? '/agent-samples' : null,
    },
  ];
  return (
    <section aria-label="规则库" className="min-w-0">
      <DashCard title="规则库" state={state} skeletonRows={4} className="h-full">
        <ul className="grid grid-cols-2 gap-3">
          {items.map((it) => {
            const value = stats ? fmt(stats[it.key]) : null;
            const body: ReactNode = (
              <>
                <span className="text-[12.5px] text-ink-3">{it.label}</span>
                <b className="font-num mt-1 block text-[24px] font-bold leading-8 tabular-nums text-ink">
                  {value ?? <span className="text-ink-3">—</span>}
                </b>
              </>
            );
            const box = 'block rounded-xl border border-line bg-white/80 px-3.5 py-3';
            return (
              <li key={it.key} className="min-w-0">
                {it.to && value != null ? (
                  <Link
                    to={it.to}
                    aria-label={`${it.label} ${value}`}
                    className={`${box} hover:border-brand-400`}
                  >
                    {body}
                  </Link>
                ) : (
                  <div className={box}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      </DashCard>
    </section>
  );
}
