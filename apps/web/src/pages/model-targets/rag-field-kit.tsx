import type { ReactNode } from 'react';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { RagFormState } from './rag-form';

type StrKey = {
  [K in keyof RagFormState]: RagFormState[K] extends string ? K : never;
}[keyof RagFormState];

export interface RagCtx<T extends RagFormState> {
  form: T;
  setForm: (next: T) => void;
}

/** 单行文本字段；id 由键名派生，label 用于无障碍定位。 */
export function RagText<T extends RagFormState>({
  ctx,
  k,
  label,
  hint,
  placeholder,
  type,
}: {
  ctx: RagCtx<T>;
  k: StrKey;
  label: string;
  hint?: ReactNode;
  placeholder?: string;
  type?: string;
}) {
  const id = `rag-${k}`;
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <Input
        id={id}
        type={type}
        autoComplete={type === 'password' ? 'new-password' : undefined}
        value={ctx.form[k] as string}
        onChange={(e) => ctx.setForm({ ...ctx.form, [k]: e.target.value })}
        placeholder={placeholder}
        className="font-mono text-xs"
      />
    </Field>
  );
}

export function RagJson<T extends RagFormState>({
  ctx,
  k,
  label,
  hint,
  placeholder,
}: {
  ctx: RagCtx<T>;
  k: StrKey;
  label: string;
  hint?: ReactNode;
  placeholder?: string;
}) {
  const id = `rag-${k}`;
  return (
    <Field label={label} htmlFor={id} hint={hint} className="sm:col-span-2">
      <Textarea
        id={id}
        rows={4}
        value={ctx.form[k] as string}
        onChange={(e) => ctx.setForm({ ...ctx.form, [k]: e.target.value })}
        placeholder={placeholder}
        className="font-mono text-xs"
      />
    </Field>
  );
}

export function RagSelect<T extends RagFormState>({
  ctx,
  k,
  label,
  options,
  hint,
}: {
  ctx: RagCtx<T>;
  k: StrKey;
  label: string;
  options: { value: string; label: string }[];
  hint?: ReactNode;
}) {
  const id = `rag-${k}`;
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <Select
        id={id}
        value={ctx.form[k] as string}
        onChange={(e) => ctx.setForm({ ...ctx.form, [k]: e.target.value })}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** 配置分组：标题 + 说明 + 两列字段栅格。 */
export function RagGroup({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: ReactNode;
  children: ReactNode;
}) {
  return (
    <fieldset className="rounded-md border border-slate-200 p-3">
      <legend className="px-1 text-[13px] font-medium text-slate-800">{title}</legend>
      {desc && <p className="mb-2 text-xs text-slate-500">{desc}</p>}
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}
