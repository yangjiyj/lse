import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import {
  DETECT_CATEGORIES,
  TOOL_CODE_PATTERN,
  TOOL_TASK_ENTRIES,
  type DetectCategory,
} from '@lse/shared';
import { toolsApi, type ToolConfigParam, type ToolDetail } from '@/lib/tools';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { TOOLS_QUERY_KEY, categoryLabel } from './labels';

const EMPTY_PARAM: ToolConfigParam = {
  name: '',
  label: '',
  description: '',
  defaultValue: '',
  required: false,
};

/** 新建或编辑工具：名称、类别、任务入口、简介、操作说明、配置参数。编码只在新建时填。 */
export function ToolFormModal({
  tool,
  onClose,
  onSaved,
}: {
  tool?: ToolDetail;
  onClose: () => void;
  onSaved?: (tool: ToolDetail) => void;
}) {
  const qc = useQueryClient();
  const { success } = useToast();
  const [code, setCode] = useState('');
  const [name, setName] = useState(tool?.name ?? '');
  const [category, setCategory] = useState<DetectCategory>(tool?.category ?? 'model');
  const [taskEntry, setTaskEntry] = useState(tool?.taskEntry ?? '');
  const [description, setDescription] = useState(tool?.description ?? '');
  const [instructions, setInstructions] = useState(tool?.instructions ?? '');
  const [params, setParams] = useState<ToolConfigParam[]>(tool?.configParams ?? []);
  const [error, setError] = useState('');
  const builtin = Boolean(tool?.builtin);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        category,
        description: description.trim(),
        instructions,
        configParams: params.map((p) => ({ ...p, name: p.name.trim(), label: p.label.trim() })),
        taskEntry: taskEntry || null,
      };
      if (!tool) return toolsApi.create({ code: code.trim(), ...body });
      // 内置工具的类别和任务入口固定，不提交。
      const { category: _c, taskEntry: _t, ...rest } = body;
      return toolsApi.update(tool.id, builtin ? rest : body);
    },
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: [TOOLS_QUERY_KEY] });
      success(tool ? '已保存' : '已新建工具');
      onSaved?.(saved);
      onClose();
    },
    onError: (e) => setError((e as Error).message),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!tool && !TOOL_CODE_PATTERN.test(code.trim()))
      return setError('编码只能用小写字母、数字和连字符，首尾不能是连字符');
    if (!name.trim()) return setError('请填写名称');
    if (params.some((p) => !p.name.trim() || !p.label.trim()))
      return setError('配置参数的参数名和显示名都要填');
    save.mutate();
  };

  const setParam = (i: number, patch: Partial<ToolConfigParam>) =>
    setParams((list) => list.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={tool ? '编辑工具' : '新建工具'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" form="tool-form" disabled={save.isPending}>
            保存
          </Button>
        </>
      }
    >
      <form id="tool-form" className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
        {!tool && (
          <Field
            label="编码"
            htmlFor="tool-code"
            required
            hint="小写字母、数字、连字符，建好后不能改"
          >
            <Input id="tool-code" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
        )}
        <Field label="名称" htmlFor="tool-name" required>
          <Input id="tool-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="类别" htmlFor="tool-category">
          <Select
            id="tool-category"
            value={category}
            disabled={builtin}
            onChange={(e) => setCategory(e.target.value as DetectCategory)}
          >
            {DETECT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="任务入口" htmlFor="tool-task-entry">
          <Select
            id="tool-task-entry"
            value={taskEntry}
            disabled={builtin}
            onChange={(e) => setTaskEntry(e.target.value)}
          >
            <option value="">无</option>
            {Object.values(TOOL_TASK_ENTRIES).map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="简介" htmlFor="tool-description" className="sm:col-span-2">
          <Input
            id="tool-description"
            value={description}
            maxLength={2000}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field
          label="操作说明"
          htmlFor="tool-instructions"
          className="sm:col-span-2"
          hint="纯文本，空一行分段"
        >
          <Textarea
            id="tool-instructions"
            rows={8}
            value={instructions}
            maxLength={20000}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </Field>
        <div className="sm:col-span-2">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[13.5px] font-medium text-ink">配置参数</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setParams((list) => [...list, { ...EMPTY_PARAM }])}
            >
              <Plus className="h-3.5 w-3.5" />
              添加参数
            </Button>
          </div>
          <div className="space-y-2">
            {params.map((p, i) => (
              <div
                key={i}
                className="grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-[1fr_1fr_1fr_auto_auto]"
              >
                <Input
                  aria-label={`第 ${i + 1} 个参数的参数名`}
                  placeholder="参数名"
                  value={p.name}
                  onChange={(e) => setParam(i, { name: e.target.value })}
                />
                <Input
                  aria-label={`第 ${i + 1} 个参数的显示名`}
                  placeholder="显示名"
                  value={p.label}
                  onChange={(e) => setParam(i, { label: e.target.value })}
                />
                <Input
                  aria-label={`第 ${i + 1} 个参数的默认值`}
                  placeholder="默认值"
                  value={p.defaultValue}
                  onChange={(e) => setParam(i, { defaultValue: e.target.value })}
                />
                <label className="inline-flex items-center gap-1.5 text-[13px] text-ink-2">
                  <input
                    type="checkbox"
                    checked={p.required}
                    onChange={(e) => setParam(i, { required: e.target.checked })}
                  />
                  必填
                </label>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`删除第 ${i + 1} 个参数`}
                  onClick={() => setParams((list) => list.filter((_, j) => j !== i))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
                <Input
                  aria-label={`第 ${i + 1} 个参数的说明`}
                  placeholder="说明"
                  className="sm:col-span-5"
                  value={p.description}
                  onChange={(e) => setParam(i, { description: e.target.value })}
                />
              </div>
            ))}
          </div>
        </div>
        {error && (
          <p className="text-sm text-destructive sm:col-span-2" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
