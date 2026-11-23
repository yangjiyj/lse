import { cn } from '@/lib/utils';

export interface RadioPillOption<T extends string> {
  value: T;
  label: string;
}

interface RadioPillsProps<T extends string> {
  options: Array<RadioPillOption<T>>;
  value: T;
  onChange: (value: T) => void;
  name: string;
  className?: string;
}

/** 单选胶囊组：原生 radio 保留可访问性，选中态为品牌蓝描边。 */
export function RadioPills<T extends string>({
  options,
  value,
  onChange,
  name,
  className,
}: RadioPillsProps<T>) {
  return (
    <div className={cn('flex flex-wrap gap-2', className)} role="radiogroup">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <label
            key={opt.value}
            className={cn(
              'inline-flex h-9 cursor-pointer items-center rounded-[10px] border px-3.5 text-[13.5px] transition-colors focus-within:ring-2 focus-within:ring-ring',
              active
                ? 'border-brand-600 bg-brand-50 font-semibold text-brand-700'
                : 'border-line-2 bg-white text-ink-2 hover:border-brand-400',
            )}
          >
            <input
              type="radio"
              name={name}
              className="sr-only"
              checked={active}
              onChange={() => onChange(opt.value)}
            />
            {opt.label}
          </label>
        );
      })}
    </div>
  );
}
