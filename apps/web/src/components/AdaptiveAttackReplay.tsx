import { normalizeVisibleRoundNumber, roundNumberFromZeroBasedIndex } from '@lse/shared';

const TECHNIQUE_CN: Record<string, string> = {
  boundary_reframe: '工具边界重定义',
  task_splitting: '任务拆分',
  payload_smuggling: '载荷夹带',
  argument_obfuscation: '参数混淆',
  tool_substitution: '工具替换',
  authority_override: '权威覆盖',
};

export interface ReplayRound {
  round: number;
  technique: string;
  modelResponse: string;
  successSignal: boolean;
}

interface Props {
  rounds: ReadonlyArray<ReplayRound>;
  mode: 'expert' | 'demo';
}

export function AdaptiveAttackReplay({ rounds, mode }: Props) {
  const usesZeroBasedRounds = rounds[0]?.round === 0;
  return (
    <div className="flex flex-col gap-2">
      {rounds.map((r, index) => {
        const success = r.successSignal;
        const visibleRound = usesZeroBasedRounds
          ? roundNumberFromZeroBasedIndex(r.round, index)
          : normalizeVisibleRoundNumber(r.round, index + 1);
        if (mode === 'expert') {
          return (
            <div
              key={r.round}
              data-testid={`round-${r.round}`}
              className="rounded-md border border-slate-700 bg-slate-900/60 p-2 text-xs"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-sky-300">R{visibleRound}</span>
                <span className="font-mono text-slate-500">{r.technique}</span>
                {success && <span className="text-red-400">确认风险</span>}
              </div>
              <div className="mt-1 text-slate-300">→ {r.modelResponse}</div>
            </div>
          );
        }
        const cn = TECHNIQUE_CN[r.technique] ?? '其他对抗策略';
        return (
          <div
            key={r.round}
            data-testid={`round-${r.round}`}
            className="rounded-md border border-slate-700 bg-slate-900/60 p-2 text-xs"
          >
            <div className="flex items-center gap-2">
              <span className="text-slate-300">
                第 {visibleRound} 轮 · {cn}
              </span>
              {success && <span className="text-red-400">确认风险</span>}
            </div>
            <div className="mt-1 text-slate-500">→ {r.modelResponse}</div>
          </div>
        );
      })}
    </div>
  );
}
