import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

export interface SearchOption {
  id: string;
  label: string;
}

/**
 * 可搜索的选择框：输关键字（防抖后按关键字查后端），再从结果里选。
 * 默认搜索框在上、下拉在下；inline 时两者排成同高的一行（放在一行筛选控件里用）。
 * 已选中的项不在当前结果里时也保留显示，不会被搜索冲掉。
 */
export function SearchSelect({
  id,
  label,
  ariaLabel,
  className,
  value,
  selected,
  queryKey,
  search,
  emptyLabel,
  enabled = true,
  inline = false,
  onChange,
}: {
  id: string;
  /** 搜索框的读屏名称是「搜索<label>」 */
  label: string;
  /** 下拉框自己的读屏名称（外面没有 label 指向它时用） */
  ariaLabel?: string;
  className?: string;
  value: string;
  /** 当前选中项（显示用） */
  selected?: SearchOption | null;
  queryKey: readonly unknown[];
  search: (keyword: string) => Promise<SearchOption[]>;
  emptyLabel: string;
  enabled?: boolean;
  inline?: boolean;
  onChange: (id: string, option: SearchOption | null) => void;
}) {
  const [keyword, setKeyword] = useState('');
  const term = useDebouncedValue(keyword.trim());
  const results = useQuery({
    queryKey: [...queryKey, term],
    queryFn: () => search(term),
    enabled,
  });
  const options = results.data ?? [];
  const keep = selected && selected.id === value && !options.some((o) => o.id === value);
  return (
    <div className={cn(inline ? 'flex items-center gap-2' : 'flex flex-col gap-1.5', className)}>
      <Input
        aria-label={`搜索${label}`}
        placeholder="输入关键字搜索"
        className={inline ? 'w-40' : undefined}
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
      />
      <Select
        id={id}
        aria-label={ariaLabel}
        className={inline ? 'w-48' : undefined}
        value={value}
        onChange={(e) =>
          onChange(e.target.value, options.find((o) => o.id === e.target.value) ?? null)
        }
      >
        <option value="">{emptyLabel}</option>
        {keep && <option value={selected.id}>{selected.label}</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
