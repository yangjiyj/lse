import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Library } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';

type ImportMode = 'create' | 'append';
type ImportScope = 'last_round' | 'all_rounds';

/** 红队任务详情「导入题库」：把实战对抗生成的攻击题目导入自有题库，用于后续评估大模型。 */
export function ImportToQuestionBankButton({
  taskId,
  taskName,
  disabled,
}: {
  taskId: string;
  taskName: string;
  disabled?: boolean;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ImportMode>('create');
  const [scope, setScope] = useState<ImportScope>('last_round');
  const [name, setName] = useState('');
  const [questionSetId, setQuestionSetId] = useState('');

  const sets = useQuery({
    queryKey: ['question-sets', 'import-target'],
    queryFn: () => api.questionSets.list({ page: 1, pageSize: 100 }),
    enabled: open && mode === 'append',
  });
  const ownSets = (sets.data?.items ?? []).filter((set) => !set.isBuiltin);

  const mutation = useMutation({
    mutationFn: () =>
      api.evalTasks.importToQuestionBank(taskId, {
        mode,
        scope,
        ...(mode === 'create' ? { name: name.trim() } : { questionSetId }),
      }),
    onSuccess: (res) => {
      toast.success(
        `已导入 ${res.imported} 道题目${res.skipped ? `，跳过重复 ${res.skipped} 道` : ''}`,
      );
      qc.invalidateQueries({ queryKey: ['question-sets'] });
      setOpen(false);
      navigate('/question-sets');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '导入题库失败'),
  });

  const canSubmit =
    !mutation.isPending && (mode === 'create' ? name.trim().length > 0 : Boolean(questionSetId));

  return (
    <>
      <Button
        variant="outline"
        disabled={disabled}
        onClick={() => {
          setName(`${taskName} 攻击题目`);
          setOpen(true);
        }}
        title="将本次红队实战对抗生成的攻击题目导入题库列表，用于评估大模型。"
      >
        <Library className="h-4 w-4" />
        导入题库
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="导入题库"
        description="将生成的题目导入题库列表用于评估大模型：可新建自有题库，或追加到已有自有题库（按内容自动去重）。"
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button disabled={!canSubmit} onClick={() => mutation.mutate()}>
              {mutation.isPending && <Spinner className="h-4 w-4" />}
              确认导入
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="导入方式" htmlFor="import-bank-mode">
            <Select
              id="import-bank-mode"
              aria-label="导入方式"
              value={mode}
              onChange={(event) => setMode(event.target.value as ImportMode)}
            >
              <option value="create">新建自有题库</option>
              <option value="append">追加到已有自有题库</option>
            </Select>
          </Field>
          {mode === 'create' ? (
            <Field label="题库名称" htmlFor="import-bank-name" required>
              <Input
                id="import-bank-name"
                aria-label="题库名称"
                value={name}
                maxLength={200}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          ) : (
            <Field label="目标题库" htmlFor="import-bank-target" required>
              <Select
                id="import-bank-target"
                aria-label="目标题库"
                value={questionSetId}
                onChange={(event) => setQuestionSetId(event.target.value)}
              >
                <option value="">
                  {sets.isLoading ? '加载中…' : ownSets.length ? '请选择自有题库…' : '暂无自有题库'}
                </option>
                {ownSets.map((set) => (
                  <option key={set.id} value={set.id}>
                    {set.name}（{set.questionCount} 题）
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field
            label="导入范围"
            htmlFor="import-bank-scope"
            hint="最后一轮通常是攻击模型根据目标响应调整后最接近突破的攻击内容。"
          >
            <Select
              id="import-bank-scope"
              aria-label="导入范围"
              value={scope}
              onChange={(event) => setScope(event.target.value as ImportScope)}
            >
              <option value="last_round">每个场景导入最后一轮攻击内容</option>
              <option value="all_rounds">导入全部轮次攻击内容</option>
            </Select>
          </Field>
        </div>
      </Modal>
    </>
  );
}
