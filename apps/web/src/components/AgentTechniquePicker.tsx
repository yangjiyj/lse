export interface TechniqueMeta {
  id: string;
  level: string;
  label: string;
  description: string;
}

interface Props {
  techniques: ReadonlyArray<TechniqueMeta>;
  selected: string[];
  onChange: (next: string[]) => void;
}

// 将内部层级代码转换为面向用户的风险强度说明。
const LEVEL_CN: Record<string, { name: string; hint: string }> = {
  L1: { name: '基础', hint: '覆盖常见的直接边界探测' },
  L2: { name: '基础', hint: '覆盖常见的上下文重构探测' },
  L3: { name: '进阶', hint: '覆盖需要多步构造的对抗策略' },
  L4: { name: '进阶', hint: '覆盖参数与工具链组合策略' },
  L5: { name: '高级', hint: '覆盖隐蔽性较高的对抗策略' },
  L6: { name: '高级', hint: '覆盖复杂高风险对抗策略' },
};

function levelCn(level: string): { name: string; hint: string } {
  return LEVEL_CN[level] ?? { name: '常规', hint: '常规对抗策略' };
}

export function AgentTechniquePicker({ techniques, selected, onChange }: Props) {
  const selectedSet = new Set(selected);
  const toggle = (id: string) => {
    onChange(selectedSet.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  // 预设覆盖范围，便于按风险强度批量选择。
  const allIds = techniques.map((t) => t.id);
  // 常规套餐 = 初级/中级手法（L1~L4），覆盖最常见风险；全量套餐 = 全部手法。
  const regularIds = techniques
    .filter((t) => {
      const lv = (t.level || '').toUpperCase();
      return lv === 'L1' || lv === 'L2' || lv === 'L3' || lv === 'L4';
    })
    .map((t) => t.id);
  const presetRegular = regularIds.length > 0 ? regularIds : allIds;

  const selectAll = () => onChange(allIds);
  const selectRegular = () => onChange(presetRegular);
  const clearAll = () => onChange([]);

  return (
    <div className="flex flex-col gap-3">
      {/* 覆盖范围预设。 */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-500">快速选择：</span>
        <button
          type="button"
          onClick={selectRegular}
          className="rounded-md border border-sky-600 bg-sky-950/40 px-2.5 py-1 text-sky-200 hover:bg-sky-900/50"
        >
          常规覆盖
        </button>
        <button
          type="button"
          onClick={selectAll}
          className="rounded-md border border-emerald-600 bg-emerald-950/40 px-2.5 py-1 text-emerald-200 hover:bg-emerald-900/50"
        >
          完整覆盖（推荐）
        </button>
        <button
          type="button"
          onClick={clearAll}
          className="rounded-md border border-slate-700 px-2.5 py-1 text-slate-500 hover:bg-slate-800/50"
        >
          清空
        </button>
        <span className="text-slate-500">
          已选 {selected.length} / {techniques.length} 项
        </span>
      </div>
      <p className="text-xs text-slate-500">
        常规覆盖包含基础与进阶策略；完整覆盖同时包含高级策略，建议首次评估使用。
      </p>

      <div role="group" aria-label="对抗策略选择" className="flex flex-col gap-2">
        {techniques.map((t) => {
          const checked = selectedSet.has(t.id);
          const lv = levelCn((t.level || '').toUpperCase());
          return (
            <label
              key={t.id}
              data-testid={`technique-${t.id}`}
              className="flex cursor-pointer items-start gap-2 rounded-md border border-slate-700 bg-slate-900/60 p-2 text-sm"
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(t.id)}
                className="mt-0.5"
              />
              <div className="flex-1">
                <div className="text-sm">
                  <span className="text-slate-100">{t.label}</span>
                  <span className="ml-2 rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-300">
                    危险度：{lv.name}
                  </span>
                </div>
                <div className="text-xs text-slate-500">{t.description}</div>
                <div className="text-xs text-slate-500">{lv.hint}</div>
              </div>
            </label>
          );
        })}
      </div>

      {/* 技术细节：英文技术码只在这里展示，普通客户可以不看 */}
      <details className="rounded-md border border-slate-800 bg-slate-950/40 p-2 text-xs">
        <summary className="cursor-pointer text-slate-500">
          查看技术细节（英文技术码，供专家核对）
        </summary>
        <div className="mt-2 flex flex-col gap-1">
          {techniques.map((t) => (
            <div key={t.id} className="flex items-center gap-2">
              <span className="font-mono text-xs text-sky-300">{t.level}</span>
              <span className="font-mono text-xs text-slate-500">{t.id}</span>
              <span className="text-slate-300">{t.label}</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
