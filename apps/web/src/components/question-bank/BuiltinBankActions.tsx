import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Copy, PlayCircle } from 'lucide-react';
import { api, ApiError, type QuestionSet } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';

/** 内置题库操作：一键“用于评估”、“复制为自有题库”。 */
export function BuiltinBankActions({ set }: { set: QuestionSet }) {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const copy = useMutation({
    mutationFn: () => api.questionSets.copy(set.id),
    onSuccess: (r) => {
      toast.success(`已复制为自有题库「${r.name}」（${r.questionCount} 题）`);
      void qc.invalidateQueries({ queryKey: ['question-sets'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '复制失败'),
  });
  return (
    <div className="flex flex-wrap gap-2">
      {hasPermission('eval_task:create') && (
        <Button
          size="sm"
          onClick={() => navigate('/eval-tasks', { state: { useQuestionSetId: set.id } })}
        >
          <PlayCircle className="h-3.5 w-3.5" />
          用于评估
        </Button>
      )}
      {hasPermission('question_set:create') && (
        <Button size="sm" variant="outline" disabled={copy.isPending} onClick={() => copy.mutate()}>
          <Copy className="h-3.5 w-3.5" />
          复制为自有题库
        </Button>
      )}
    </div>
  );
}
