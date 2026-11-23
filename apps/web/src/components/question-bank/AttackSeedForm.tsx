import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BINDABLE_TAXONOMIES, listBuiltinMinors, type BuiltinTaxonomyId } from '@lse/shared';
import { api, type AttackSeedSpec } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Field } from '@/components/ui/field';

export const MAX_SCENARIOS = 50;
export const MAX_PER_SCENARIO = 50;
const NEW_DOMAIN = '__new__';

const clamp = (v: number, max: number) => Math.min(max, Math.max(1, Math.floor(v) || 1));

/** 攻击种子泛化表单：测试领域 / 测试范围 / 重点关注方向 / 参考关键词 / 场景数量 / 每场景问题数量 / 绑定标准。 */
export function AttackSeedForm({
  spec,
  onChange,
}: {
  spec: AttackSeedSpec;
  onChange: (next: AttackSeedSpec) => void;
}) {
  const domains = useQuery({
    queryKey: ['attack-seed-domains'],
    queryFn: () => api.questionSets.attackSeedDomains(),
  });
  const known = domains.data?.items ?? [];
  const [creating, setCreating] = useState(false);
  const [kwText, setKwText] = useState(spec.keywords.join('，'));
  const set = (patch: Partial<AttackSeedSpec>) => onChange({ ...spec, ...patch });
  const minors = spec.binding ? listBuiltinMinors(spec.binding.taxonomy) : [];
  const selectValue =
    creating || !known.some((d) => d.name === spec.domain) ? NEW_DOMAIN : spec.domain;

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Field label="测试领域" hint="选择已有测试领域，或新建领域（保存时自动持久化）">
        <div className="flex gap-2">
          <Select
            aria-label="测试领域"
            value={selectValue}
            onChange={(e) => {
              const isNew = e.target.value === NEW_DOMAIN;
              setCreating(isNew);
              set({ domain: isNew ? '' : e.target.value });
            }}
          >
            {known.map((d) => (
              <option key={d.id} value={d.name}>
                {d.name}
              </option>
            ))}
            <option value={NEW_DOMAIN}>新建领域…</option>
          </Select>
          {selectValue === NEW_DOMAIN && (
            <Input
              aria-label="新建领域名称"
              placeholder="如：油气管网调控"
              value={spec.domain}
              onChange={(e) => set({ domain: e.target.value })}
            />
          )}
        </div>
      </Field>
      <Field label="参考关键词" hint="多个关键词用逗号分隔">
        <Input
          aria-label="参考关键词"
          value={kwText}
          onChange={(e) => {
            setKwText(e.target.value);
            set({
              keywords: e.target.value
                .split(/[,，、\s]+/)
                .map((k) => k.trim())
                .filter(Boolean),
            });
          }}
        />
      </Field>
      <Field label="测试范围">
        <Textarea
          aria-label="测试范围"
          rows={2}
          value={spec.scope}
          onChange={(e) => set({ scope: e.target.value })}
        />
      </Field>
      <Field label="重点关注方向">
        <Textarea
          aria-label="重点关注方向"
          rows={2}
          value={spec.focus}
          onChange={(e) => set({ focus: e.target.value })}
        />
      </Field>
      <Field label="场景数量" hint={`1–${MAX_SCENARIOS}`}>
        <Input
          aria-label="场景数量"
          type="number"
          min={1}
          max={MAX_SCENARIOS}
          value={spec.scenarioCount}
          onChange={(e) => set({ scenarioCount: clamp(Number(e.target.value), MAX_SCENARIOS) })}
        />
      </Field>
      <Field label="每场景问题数量" hint={`1–${MAX_PER_SCENARIO}`}>
        <Input
          aria-label="每场景问题数量"
          type="number"
          min={1}
          max={MAX_PER_SCENARIO}
          value={spec.questionsPerScenario}
          onChange={(e) =>
            set({ questionsPerScenario: clamp(Number(e.target.value), MAX_PER_SCENARIO) })
          }
        />
      </Field>
      <Field label="绑定标准" hint="将生成场景绑定至选定标准，可细到分类">
        <Select
          aria-label="绑定标准"
          value={spec.binding?.taxonomy ?? ''}
          onChange={(e) =>
            set({
              binding: e.target.value
                ? { taxonomy: e.target.value as BuiltinTaxonomyId, categories: [] }
                : null,
            })
          }
        >
          <option value="">不绑定</option>
          {BINDABLE_TAXONOMIES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </Field>
      {spec.binding && (
        <Field label="绑定分类" hint="不选表示整个标准">
          <div
            className="flex max-h-32 flex-wrap gap-x-3 gap-y-1 overflow-auto text-xs"
            role="group"
            aria-label="绑定分类"
          >
            {minors.map((c) => (
              <label key={c.minorCode} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={spec.binding!.categories.includes(c.minorCode)}
                  onChange={(e) => {
                    const cur = spec.binding!.categories;
                    const categories = e.target.checked
                      ? [...cur, c.minorCode]
                      : cur.filter((x) => x !== c.minorCode);
                    set({ binding: { ...spec.binding!, categories } });
                  }}
                />
                {c.minor}
              </label>
            ))}
          </div>
        </Field>
      )}
    </div>
  );
}
