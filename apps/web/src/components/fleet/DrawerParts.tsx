import { useState, type ReactNode } from 'react';
import type {
  EndpointRiskGroup,
  OverviewAssetState,
} from '../../../../../packages/shared/src/endpoint-overview';
import {
  NOT_CHECKED_CAUSES,
  NOT_CHECKED_OWNER_LABELS,
  notCheckedCause,
  type NotCheckedCause,
  type NotCheckedOwner,
} from '../../../../../packages/shared/src/not-checked';
import { Badge } from '@/components/ui/badge';
import type { BadgeTone } from '@/lib/format';
import { stateLabels } from './overview-labels';

/** 抽屉里的一个分区：小标题 + 内容。 */
export function DrawerSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium text-ink-3">{title}</h3>
      {children}
    </section>
  );
}

/** 抽屉标题下的一行元信息：各项用“·”隔开，空项跳过，避免几项文字挤在一起读串。 */
export function Meta({ items }: { items: Array<string | null | undefined | false> }) {
  const shown = items.filter((item): item is string => !!item);
  return shown.length ? <span>{shown.join(' · ')}</span> : null;
}

/** 资产状态徽标；label 可换成更具体的短语（例如“脚本没查完”）。 */
export function StateBadge({ state, label }: { state: OverviewAssetState; label?: string }) {
  return (
    <Badge
      className={state === 'risk' ? 'bg-[#FDECEA] text-[#B42318]' : undefined}
      tone={state === 'risk' ? 'danger' : state === 'clear' ? 'success' : 'neutral'}
    >
      {label ?? stateLabels[state]}
    </Badge>
  );
}

const OWNER_TONE: Record<NotCheckedOwner, BadgeTone> = {
  admin: 'warning',
  manual: 'info',
  probe: 'neutral',
};

/** 谁来处理这项没检查：管理员 / 人工 / 探针暂时查不了。 */
export function OwnerChip({ owner }: { owner: NotCheckedOwner }) {
  return <Badge tone={OWNER_TONE[owner]}>{NOT_CHECKED_OWNER_LABELS[owner]}</Badge>;
}

/** 成因键 → 词表条目；词表外的键（旧响应）退回“终端没有提供这项检查”。 */
export function causeOf(key: string | undefined | null): NotCheckedCause {
  return notCheckedCause(key) ?? NOT_CHECKED_CAUSES.check_missing;
}

const FOLD_AT = 8;

/**
 * 对象清单：不超过 8 个直接列出，更多的先显示前 8 个，其余点开才看；
 * moreCount 是接口已经截掉、前端拿不到名字的数量。
 */
export function SubjectList({
  subjects,
  moreCount = 0,
}: {
  subjects: Array<{ name: string; detail: string }>;
  moreCount?: number;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? subjects : subjects.slice(0, FOLD_AT);
  const hidden = subjects.length - shown.length;
  return (
    <div>
      <ul className="divide-y divide-line">
        {shown.map((s, i) => (
          <li key={`${s.name}-${i}`} className="py-1.5">
            <div className="break-words font-medium">{s.name}</div>
            {s.detail && <div className="break-words text-xs text-ink-3">{s.detail}</div>}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          className="mt-1.5 text-xs text-brand-700 hover:underline"
          onClick={() => setAll(true)}
        >
          展开其余 {hidden} 个
        </button>
      )}
      {all && subjects.length > FOLD_AT && (
        <button
          type="button"
          className="mt-1.5 block text-xs text-brand-700 hover:underline"
          onClick={() => setAll(false)}
        >
          收起
        </button>
      )}
      {moreCount > 0 && (all || hidden === 0) && (
        <p className="mt-1.5 text-xs text-ink-3">另有 {moreCount} 个</p>
      )}
    </div>
  );
}

/**
 * 一类没检查的成因：标题（可省略）、原因、办法，下面是涉及的对象。
 * 标题省略时，调用方已经在抽屉标题里说过这一类，这里只写原因和办法。
 * “一律如此”的成因（探针整体不上报）没有对象明细，只给数量。
 */
export function CauseBlock({
  title,
  meta,
  basis,
  advice,
  owner,
  children,
}: {
  title?: string;
  /** 标题右侧的小字，例如“65 个技能”或涉及的检查项。 */
  meta?: ReactNode;
  basis: string;
  advice: string;
  owner?: NotCheckedOwner;
  children?: ReactNode;
}) {
  return (
    <section className="space-y-2">
      {title && (
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 text-sm font-semibold leading-6">{title}</h3>
          <div className="flex shrink-0 items-center gap-2">
            {meta && <span className="text-xs tabular-nums text-ink-3">{meta}</span>}
            {owner && <OwnerChip owner={owner} />}
          </div>
        </div>
      )}
      <p>{basis}</p>
      <p className="text-ink-2">
        <span className="mr-1.5 font-medium text-ink">办法</span>
        {advice}
      </p>
      {children}
    </section>
  );
}

/** 风险行里的一类成因（文字取接口给的）。bare 表示抽屉标题已经是这一类的标题。 */
export function NotCheckedGroup({
  group,
  bare = false,
}: {
  group: EndpointRiskGroup;
  bare?: boolean;
}) {
  const known = notCheckedCause(group.cause);
  return (
    <CauseBlock
      title={bare ? undefined : group.title}
      meta={`${group.subjectCount} ${known?.unit ?? '处'}`}
      basis={group.basis}
      advice={group.advice}
    >
      {group.subjects.length > 0 && (
        <SubjectList subjects={group.subjects} moreCount={group.moreCount} />
      )}
    </CauseBlock>
  );
}
