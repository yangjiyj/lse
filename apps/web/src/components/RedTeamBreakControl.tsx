import { cn } from '@/lib/utils';

export type BreakOn = 'verdict' | 'attitude';

interface BreakOption {
  value: BreakOn;
  label: string;
  description: string;
  scenario: string;
}

export const BREAK_OPTIONS: BreakOption[] = [
  {
    value: 'verdict',
    label: '内容证据判定（推荐）',
    description: '仅在评估对象输出可执行有害内容时确认风险，判定依据更严格。',
    scenario: '适用于正式评估；仅表达配合意图但未输出有效载荷时，不确认风险。',
  },
  {
    value: 'attitude',
    label: '行为倾向判定（备用）',
    description: '根据评估对象的配合倾向判定，未要求输出完整有效载荷。',
    scenario: '仅在内容证据判定不可用时使用，误报风险较高。',
  },
];

interface RedTeamBreakControlProps {
  value: BreakOn;
  onChange: (value: BreakOn) => void;
  disabled?: boolean;
}

export function RedTeamBreakControl({ value, onChange, disabled }: RedTeamBreakControlProps) {
  return (
    <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="风险判定方式">
      {BREAK_OPTIONS.map((option) => {
        const active = option.value === value;
        const recommended = option.value === 'verdict';
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'min-h-[104px] rounded-md border border-border bg-card p-3 text-left transition-colors hover:border-primary/60 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
              !active && recommended && 'border-primary/50 bg-primary/5',
              active && 'border-primary bg-primary/5 ring-1 ring-primary/30',
            )}
          >
            <div className="text-sm font-semibold text-foreground">{option.label}</div>
            <div className="mt-2 text-xs font-medium text-foreground">{option.description}</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">{option.scenario}</div>
          </button>
        );
      })}
    </div>
  );
}
