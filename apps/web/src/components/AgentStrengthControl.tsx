import type { AgentEvalLevel, AgentRiskSurface } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface AgentStrengthOption {
  level: AgentEvalLevel;
  label: string;
  defaultSampleCount: number;
  maxTurns: number;
  description: string;
  scenario: string;
  recommended?: boolean;
  riskSurfaces: AgentRiskSurface[];
}

export const AGENT_STRENGTH_OPTIONS: AgentStrengthOption[] = [
  {
    level: 'smoke',
    label: '快速验证',
    defaultSampleCount: 16,
    maxTurns: 1,
    description: '单轮工具调用 · 基础核验',
    scenario: '适用于接入后的连通性与基础风险核验',
    riskSurfaces: ['ssrf', 'secret_read', 'dangerous_command', 'indirect_prompt_injection'],
  },
  {
    level: 'standard',
    label: '标准评估',
    defaultSampleCount: 48,
    maxTurns: 2,
    description: '两轮工具调用 · 常规覆盖',
    scenario: '适用于上线前常规评估，覆盖主要工具调用风险（推荐）',
    recommended: true,
    riskSurfaces: [
      'ssrf',
      'secret_read',
      'file_read',
      'dangerous_command',
      'data_exfiltration',
      'indirect_prompt_injection',
      'tool_argument_bypass',
    ],
  },
  {
    level: 'deep',
    label: '深度对抗',
    defaultSampleCount: 128,
    maxTurns: 3,
    description: '三轮工具调用 · 扩展覆盖',
    scenario: '适用于重点系统上线前的扩展风险覆盖',
    riskSurfaces: [
      'ssrf',
      'secret_read',
      'file_read',
      'dangerous_command',
      'data_exfiltration',
      'indirect_prompt_injection',
      'tool_argument_bypass',
    ],
  },
  {
    level: 'adversarial',
    label: '对抗研究',
    defaultSampleCount: 320,
    maxTurns: 4,
    description: '四轮工具调用 · 专项研究',
    scenario: '适用于专项对抗研究，覆盖范围最广且耗时较长',
    riskSurfaces: [
      'ssrf',
      'secret_read',
      'file_read',
      'dangerous_command',
      'data_exfiltration',
      'indirect_prompt_injection',
      'tool_argument_bypass',
    ],
  },
];

export function agentStrengthOption(level: AgentEvalLevel): AgentStrengthOption {
  return (
    AGENT_STRENGTH_OPTIONS.find((option) => option.level === level) ?? AGENT_STRENGTH_OPTIONS[1]!
  );
}

interface AgentStrengthControlProps {
  value: AgentEvalLevel;
  onChange: (value: AgentEvalLevel) => void;
  disabled?: boolean;
}

export function AgentStrengthControl({ value, onChange, disabled }: AgentStrengthControlProps) {
  return (
    <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="评估强度">
      {AGENT_STRENGTH_OPTIONS.map((option) => {
        const active = option.level === value;
        return (
          <button
            key={option.level}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onChange(option.level)}
            className={cn(
              'min-h-[104px] rounded-md border border-border bg-card p-3 text-left transition-colors hover:border-primary/60 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
              active && 'border-primary bg-primary/5 ring-1 ring-primary/30',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5">
                <span className="text-sm font-semibold text-foreground">{option.label}</span>
                {option.recommended && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    推荐
                  </span>
                )}
              </span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {option.maxTurns} 轮
              </span>
            </div>
            <div className="mt-2 text-xs font-medium text-foreground">{option.description}</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">{option.scenario}</div>
          </button>
        );
      })}
    </div>
  );
}
