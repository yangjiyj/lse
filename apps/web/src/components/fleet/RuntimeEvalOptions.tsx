import type { ReactNode } from 'react';
import { NoteBox } from '@/components/page-kit/NoteBox';
import {
  RUNTIME_ARMS,
  RUNTIME_TEMPLATES,
  RUNTIME_TIERS,
  RUNTIME_VECTORS,
  RUNTIME_VECTOR_LABELS,
  type RuntimeSuite,
} from '../../../../../packages/shared/src/runtime-eval';
import {
  RUNTIME_ARM_INFO,
  RUNTIME_TEMPLATE_LABELS,
  RUNTIME_TIER_INFO,
  runtimeTierDefaults,
  type RuntimeForm,
} from './runtime-eval-form';

const pill =
  'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50 has-[:checked]:text-brand-700';
const gridRow = 'grid grid-cols-[64px_minmax(0,1fr)] items-start gap-x-3';

/** 按固定顺序切换选中项，提交的数组顺序稳定。 */
const pick = <T,>(all: readonly T[], selected: T[], value: T) =>
  all.filter((x) => (x === value ? !selected.includes(x) : selected.includes(x)));
const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className={gridRow}>
    <span className="pt-1 text-xs text-ink-3">{label}</span>
    <div className="min-w-0">{children}</div>
  </div>
);
const Warn = ({ children }: { children: ReactNode }) => (
  <p role="alert" className="mt-1 text-xs text-severity-high">
    {children}
  </p>
);

/** 真机测评的套件选择：经典 12 场景 / 运行态测评。不可选时灰显并写明原因。 */
export function SuiteSelect({
  value,
  onChange,
  blockedReason,
  disabled,
}: {
  value: RuntimeSuite;
  onChange: (next: RuntimeSuite) => void;
  blockedReason: string;
  disabled: boolean;
}) {
  const option = (suite: RuntimeSuite, label: string, off: boolean) => (
    <button
      type="button"
      aria-pressed={value === suite}
      disabled={off || disabled}
      title={off ? blockedReason : undefined}
      onClick={() => onChange(suite)}
      className={`rounded-full border px-3 py-1 text-xs ${
        off
          ? 'cursor-not-allowed border-dashed bg-slate-50 text-slate-400'
          : value === suite
            ? 'border-brand-500 bg-brand-50 text-brand-700'
            : 'hover:border-brand-400/70'
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className={gridRow}>
      <span className="pt-1 text-xs text-ink-3">测评套件</span>
      <div>
        <div role="group" aria-label="测评套件" className="flex flex-wrap gap-2">
          {option('classic', '经典 12 场景', false)}
          {option('runtime_v2', '运行态测评', !!blockedReason)}
        </div>
        {blockedReason && <p className="mt-1 text-xs text-ink-3">{blockedReason}</p>}
      </div>
    </div>
  );
}

export function RuntimeEvalOptions({
  value,
  onChange,
  ack,
  onAck,
  disabled,
}: {
  value: RuntimeForm;
  onChange: (next: RuntimeForm) => void;
  ack: boolean;
  onAck: (checked: boolean) => void;
  disabled: boolean;
}) {
  const set = (patch: Partial<RuntimeForm>) => onChange({ ...value, ...patch });
  return (
    <fieldset disabled={disabled} aria-label="运行态测评选项" className="min-w-0 space-y-3">
      <Row label="档位">
        <div role="radiogroup" aria-label="档位" className="space-y-1.5">
          {RUNTIME_TIERS.map((t) => (
            <label key={t} className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <input
                type="radio"
                name="runtime-tier"
                aria-label={RUNTIME_TIER_INFO[t].label}
                checked={value.tier === t}
                onChange={() => onChange({ ...value, tier: t, ...runtimeTierDefaults(t) })}
              />
              <span className="font-medium">{RUNTIME_TIER_INFO[t].label}</span>
              <span className="text-ink-3">{RUNTIME_TIER_INFO[t].hint}</span>
            </label>
          ))}
        </div>
      </Row>
      <Row label="攻击类别">
        <div className="flex flex-wrap gap-2">
          {RUNTIME_VECTORS.map((v) => (
            <label key={v} className={pill}>
              <input
                type="checkbox"
                aria-label={RUNTIME_VECTOR_LABELS[v]}
                checked={value.vectors.includes(v)}
                onChange={() => set({ vectors: pick(RUNTIME_VECTORS, value.vectors, v) })}
              />
              {RUNTIME_VECTOR_LABELS[v]}
            </label>
          ))}
        </div>
        {!value.vectors.length && <Warn>请至少选择一个攻击类别</Warn>}
      </Row>
      <Row label="防护臂">
        <div className="space-y-1.5">
          {RUNTIME_ARMS.map((a) => (
            <label key={a} className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <input
                type="checkbox"
                aria-label={RUNTIME_ARM_INFO[a].label}
                checked={value.arms.includes(a)}
                onChange={() => set({ arms: pick(RUNTIME_ARMS, value.arms, a) })}
              />
              <span className="font-medium">{RUNTIME_ARM_INFO[a].label}</span>
              <span className="text-ink-3">{RUNTIME_ARM_INFO[a].hint}</span>
            </label>
          ))}
        </div>
        {!value.arms.length && <Warn>请至少选择一个防护臂</Warn>}
      </Row>
      <Row label="项目模板">
        <div className="flex flex-wrap gap-2">
          {RUNTIME_TEMPLATES.map((t) => (
            <label key={t} className={pill}>
              <input
                type="checkbox"
                aria-label={RUNTIME_TEMPLATE_LABELS[t]}
                checked={value.templates.includes(t)}
                onChange={() => set({ templates: pick(RUNTIME_TEMPLATES, value.templates, t) })}
              />
              {RUNTIME_TEMPLATE_LABELS[t]}
            </label>
          ))}
        </div>
        {!value.templates.length && <Warn>请至少选择一个项目模板</Warn>}
      </Row>
      <Row label="重复次数">
        <div className="flex items-center gap-2 text-xs text-ink-3">
          <select
            aria-label="重复次数"
            value={value.repeat}
            onChange={(e) => set({ repeat: Number(e.target.value) })}
            className="h-8 rounded-lg border border-line bg-white px-2 text-sm text-ink"
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          次 · 同一个样本重复运行，排除偶然因素
        </div>
      </Row>
      <p className="text-xs leading-5 text-ink-3">
        {RUNTIME_TIER_INFO[value.tier].scale}
        ；会消耗模型额度；会在终端的一次性沙箱里运行，不影响真实数据。
        实际场景数随类别、防护臂、模板和重复次数变化，提交后以系统返回的数字为准。
      </p>
      <NoteBox tone="warning" className="px-3 py-2 text-xs leading-5">
        <p className="font-medium">沙箱隔离范围</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          <li>沙箱内没有外网，只放行模型出口。</li>
          <li>使用模拟用户目录，不接触真实的 ~/.ssh 等凭据。</li>
          <li>危险动作只作用于一次性仿真项目，不会碰到真实数据。</li>
          <li>“防护开”只验证终端本地策略，不含服务端策略与审批流。</li>
        </ul>
        <label className="mt-2 flex items-center gap-2">
          <input
            type="checkbox"
            aria-label="我了解防护开只验证终端本地策略"
            checked={ack}
            onChange={(e) => onAck(e.target.checked)}
          />
          我了解防护开只验证终端本地策略
        </label>
      </NoteBox>
    </fieldset>
  );
}
