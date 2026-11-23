import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Box,
  Check,
  CircleCheckBig,
  Eye,
  FileSearch,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react';
import { DashCard, type CardLoadState } from './DashCard';
import { fmt } from './utils';

export interface ActionItem {
  key: string;
  tone: 'critical' | 'high' | 'info';
  icon: ReactNode;
  title: string;
  sub: string;
  to: string;
  cta: string;
}

const TONE_ICON = {
  critical: 'bg-severity-critical-bg text-severity-critical',
  high: 'bg-severity-high-bg text-severity-high',
  info: 'bg-brand-50 text-brand-600',
} as const;

export interface ActionInputs {
  highCount: number | null;
  highTaskCount: number;
  reviewCount: number | null;
  remediationCount: number | null;
  connectionCount: number | null;
  untestedCount: number | null;
  targetCount: number | null;
  gateCount: number | null;
  /** 是否有门禁权限（无权限时不参与「已清零」汇总）。 */
  gateVisible: boolean;
  modelFileCount: number;
  canDispose: boolean;
  /** 所选统计周期名（本月 / 近 7 天 / 全部），用于标注随周期变化的数字的范围。 */
  periodLabel?: string;
}

/** 由真实数据推导待办行；未取到数的项不会被当作「已清零」。 */
export function buildActions(i: ActionInputs): {
  items: ActionItem[];
  cleared: string[];
  unknown: boolean;
} {
  const items: ActionItem[] = [];
  const cleared: string[] = [];
  let unknown = false;
  if (i.highCount == null) unknown = true;
  else if (i.highCount > 0) {
    items.push({
      key: 'high',
      tone: 'critical',
      icon: <TriangleAlert />,
      title: `${fmt(i.highCount)} 条高危回复待处置`,
      sub: [
        i.periodLabel,
        i.highTaskCount > 0 ? `来自 ${i.highTaskCount} 个高风险任务` : '含严重等级，请优先处置',
      ]
        .filter(Boolean)
        .join(' · '),
      to: i.canDispose ? '/wrong-answers' : '/my-todos',
      cta: '处置',
    });
  }
  if (i.reviewCount == null) unknown = true;
  else if (i.reviewCount > 0) {
    items.push({
      key: 'review',
      tone: 'high',
      icon: <Eye />,
      title: `${fmt(i.reviewCount)} 条风险回复待复核`,
      sub: '全部时间 · 复核后计入正式结论',
      to: '/my-todos',
      cta: '复核',
    });
  }
  if (i.connectionCount == null) unknown = true;
  else if (i.connectionCount > 0) {
    items.push({
      key: 'conn',
      tone: 'critical',
      icon: <Box />,
      title: `${fmt(i.connectionCount)} 个评估对象接入异常`,
      sub: '连通性测试未通过，影响评估执行',
      to: '/model-targets',
      cta: '处理',
    });
  }
  if (i.untestedCount != null && i.untestedCount > 0) {
    items.push({
      key: 'untested',
      tone: 'info',
      icon: <Box />,
      title: `${fmt(i.untestedCount)} 个评估对象待测试`,
      sub: i.targetCount != null ? `共 ${fmt(i.targetCount)} 个评估对象` : '尚未做连通性测试',
      // 带过滤跳转：评估对象页只显示这批未测试且可连通性测试的对象。
      to: '/model-targets?untested=1',
      cta: '测试',
    });
  }
  if (i.remediationCount == null) unknown = true;
  else if (i.remediationCount > 0) {
    items.push({
      key: 'remediation',
      tone: 'high',
      icon: <ShieldAlert />,
      title: `${fmt(i.remediationCount)} 项整改临期或逾期`,
      sub: '请跟进整改闭环',
      to: '/my-todos',
      cta: '跟进',
    });
  }
  if (i.gateVisible) {
    if (i.gateCount == null) unknown = true;
    else if (i.gateCount > 0) {
      items.push({
        key: 'gate',
        tone: 'critical',
        icon: <ShieldAlert />,
        title: `${fmt(i.gateCount)} 个上线门禁未通过`,
        sub: '未通过的门禁将阻断上线',
        to: '/eval/gates',
        cta: '查看',
      });
    }
  }
  if (i.modelFileCount > 0) {
    items.push({
      key: 'modelfile',
      tone: 'high',
      icon: <FileSearch />,
      title: `${fmt(i.modelFileCount)} 项模型文件扫描待处置`,
      sub: '含待复核与整改临期项',
      to: '/wrong-answers',
      cta: '处理',
    });
  }
  if (i.remediationCount === 0) cleared.push('整改到期');
  if (i.connectionCount === 0) cleared.push('接入异常');
  if (i.gateVisible && i.gateCount === 0) cleared.push('门禁');
  return { items, cleared, unknown };
}

/**
 * 行分隔线：列表按 1 / 2 / 3 列排（窄屏 / md / 2xl），每种列数下最后一行都不画底线，
 * 否则多列时最后一行会有的格子有线、有的没有。
 */
export function rowDividerClass(index: number, count: number): string {
  const inLastRow = (cols: number) => index >= count - (count % cols || cols);
  return [
    'border-b border-line/70',
    inLastRow(1) && 'max-md:border-b-0',
    inLastRow(2) && 'md:max-2xl:border-b-0',
    inLastRow(3) && '2xl:border-b-0',
  ]
    .filter(Boolean)
    .join(' ');
}

export function ActionList({ inputs, state }: { inputs: ActionInputs; state: CardLoadState }) {
  const { items, cleared, unknown } = buildActions(inputs);
  const allClear = items.length === 0 && !unknown;
  const rowCount = items.length + (cleared.length > 0 ? 1 : 0);
  return (
    <DashCard
      title="需要你处理"
      state={state}
      skeletonRows={5}
      className="h-full"
      action={
        <Link
          to="/my-todos"
          className="text-[13px] font-medium text-brand-600 hover:text-brand-700"
        >
          我的待办 ›
        </Link>
      }
    >
      {allClear ? (
        <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-severity-pass-bg text-severity-pass">
            <CircleCheckBig className="h-6 w-6" aria-hidden="true" />
          </span>
          <div className="text-[15px] font-semibold text-ink">已清零</div>
          <p className="text-[13px] text-ink-3">暂无需要你处理的事项</p>
        </div>
      ) : (
        <ul className="md:grid md:grid-cols-2 md:gap-x-10 2xl:grid-cols-3">
          {items.map((it, i) => (
            <li
              key={it.key}
              className={`flex items-center gap-3 py-3 ${rowDividerClass(i, rowCount)}`}
            >
              <span
                className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl [&_svg]:h-[18px] [&_svg]:w-[18px] ${TONE_ICON[it.tone]}`}
              >
                {it.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-semibold text-ink" title={it.title}>
                  {it.title}
                </div>
                <div className="truncate text-xs text-ink-3" title={it.sub}>
                  {it.sub}
                </div>
              </div>
              <Link
                to={it.to}
                aria-label={`${it.cta}：${it.title}`}
                className={
                  it.tone === 'critical'
                    ? 'inline-flex h-8 shrink-0 items-center rounded-[9px] bg-gradient-to-b from-brand-500 to-brand-600 px-4 text-[13px] font-semibold text-white shadow-btn hover:from-brand-600 hover:to-brand-700'
                    : 'inline-flex h-8 shrink-0 items-center rounded-[9px] bg-brand-50 px-4 text-[13px] font-semibold text-brand-700 hover:bg-brand-100'
                }
              >
                {it.cta}
              </Link>
            </li>
          ))}
          {cleared.length > 0 && (
            <li
              className={`flex items-center gap-3 py-3 ${rowDividerClass(rowCount - 1, rowCount)}`}
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-severity-pass-bg text-severity-pass">
                <Check className="h-[18px] w-[18px]" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-semibold text-ink">
                  {cleared.join(' · ')}
                </div>
                <div className="truncate text-xs text-ink-3">
                  {cleared.length > 1 ? `${cleared.length} 项均为 0，` : ''}无需处理
                </div>
              </div>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-severity-pass-bg px-2.5 py-0.5 text-[12.5px] font-semibold text-severity-pass">
                <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" />
                已清零
              </span>
            </li>
          )}
        </ul>
      )}
    </DashCard>
  );
}
