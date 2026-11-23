interface AttackerTarget {
  id: string;
  name: string;
  model: string;
}

interface Value {
  enabled: boolean;
  rounds?: number;
  attackerTargetId?: string;
}

interface Props {
  value: Value;
  onChange: (next: Value) => void;
  attackerTargets: ReadonlyArray<AttackerTarget>;
}

export function AdaptiveAttackConfig({ value, onChange, attackerTargets }: Props) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-slate-700 bg-slate-900/60 p-3 text-sm">
      <p className="text-xs leading-relaxed text-slate-500">
        启用后，攻击模型会根据评估对象的响应动态调整后续策略，扩大多轮对抗覆盖。
      </p>
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          role="switch"
          checked={value.enabled}
          onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
        />
        <span className="text-slate-100">启用自适应攻击（可能增加执行时间）</span>
      </label>
      {value.enabled && (
        <>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-500">轮数</label>
            <input
              type="range"
              min={1}
              max={10}
              value={value.rounds ?? 2}
              onChange={(e) => onChange({ ...value, rounds: Number(e.target.value) })}
              className="flex-1"
            />
            <span className="w-6 text-center text-xs text-slate-200">{value.rounds ?? 2}</span>
          </div>
          <p className="text-xs leading-relaxed text-slate-500">
            试探几轮，越多越彻底也越慢，建议 2-3 轮。
          </p>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-500">攻击模型</label>
            <select
              value={value.attackerTargetId ?? ''}
              onChange={(e) => onChange({ ...value, attackerTargetId: e.target.value })}
              className="flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-slate-100"
            >
              <option value="">不选则用系统默认</option>
              {attackerTargets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}（{t.model}）
                </option>
              ))}
            </select>
          </div>
        </>
      )}
    </div>
  );
}
