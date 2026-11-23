import type { ReactNode } from 'react';
import { AlertTriangle, Eye } from 'lucide-react';
import type { QuestionSet } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NoteBox } from '@/components/page-kit/NoteBox';
import { TagCluster } from '@/components/page-kit/TagCluster';
import {
  LARGE_BANK_HINT,
  gbtBankRequirement,
  isLargeBank,
  seedBankCoverage,
  seedBankMeta,
  seedBankTitle,
} from './seed-bank-meta';

/**
 * 种子库卡片。`actions` 为操作区插槽：其他功能（如「变异扩展」）把按钮放进来即可，
 * 不必改卡片本身。
 */
export function SeedBankCard({
  set,
  onView,
  actions,
}: {
  set: QuestionSet;
  onView?: () => void;
  actions?: ReactNode;
}) {
  const meta = seedBankMeta(set.source);
  const coverage = seedBankCoverage(set.source, set.riskCoverage);
  // 国标三个题库：显示在用题数和附录 B 的规模要求，不足标红。
  const required = gbtBankRequirement(set.source);
  const count =
    required === null ? set.questionCount : (set.activeQuestionCount ?? set.questionCount);
  const short = required !== null && count < required;
  return (
    <article
      className="flex h-full flex-col rounded-card border border-[#EDF1F8] bg-white p-5 shadow-card transition-shadow hover:shadow-pop"
      aria-label={`种子库 ${set.name}`}
      data-testid="seed-bank-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3
            className="flex flex-wrap items-center gap-2 text-[15px] font-bold leading-snug text-ink"
            title={set.name}
          >
            {seedBankTitle(set.name, set.source)}
            <Badge tone="info">内置</Badge>
          </h3>
          <p className="mt-1 text-xs text-ink-3">{meta.provenance}</p>
        </div>
        <div className="shrink-0 text-right">
          <div
            className={`font-num text-[22px] font-bold leading-none tabular-nums ${short ? 'text-severity-critical' : 'text-ink'}`}
          >
            {count.toLocaleString('zh-CN')}
          </div>
          <div className="mt-1 text-xs text-ink-3">
            {required === null ? '题' : `在用 / 要求 ${required.toLocaleString('zh-CN')}`}
          </div>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-[13px] leading-5">
        <dt className="text-ink-3">用途</dt>
        <dd className="text-ink">{meta.purpose}</dd>
        <dt className="text-ink-3">推荐用法</dt>
        <dd className="text-ink">{meta.usage}</dd>
        <dt className="text-ink-3">覆盖风险</dt>
        <dd>
          <TagCluster
            tone="info"
            max={4}
            tags={coverage}
            empty={<span className="text-ink-3">—</span>}
          />
        </dd>
      </dl>
      {isLargeBank(set.questionCount) ? (
        <NoteBox
          tone="warning"
          role="note"
          className="mt-3 flex items-start gap-2 py-2 text-xs leading-5"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {LARGE_BANK_HINT}
        </NoteBox>
      ) : null}
      <div className="mt-auto pt-4">
        <div
          className="flex flex-wrap items-center gap-2 border-t border-line pt-3"
          data-slot="seed-bank-actions"
        >
          {onView ? (
            <Button variant="ghost" size="sm" className="text-brand-700" onClick={onView}>
              <Eye className="h-3.5 w-3.5" />
              查看样本
            </Button>
          ) : null}
          {actions}
        </div>
      </div>
    </article>
  );
}
