import { checkLabel, checkHint } from './CheckPresentation';
import { ConnectionProbe, useTargetProbe } from './ConnectionProbe';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ragEvalApi, type RagAlignmentMode, type RagConfigCheck, type RagTarget } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { LoadingBlock } from '@/components/ui/spinner';
import { MODE_DETAIL } from './ModeStep';
import { AutoUploadNotice } from './AutoUploadNotice';
import { RagTargetEntry, RagTargetExplain } from './RagTargetEntry';

export function useRagTargets(mode: RagAlignmentMode) {
  return useQuery({
    queryKey: ['rag-eval', 'targets', mode],
    queryFn: () => ragEvalApi.targets(mode),
  });
}

export function NoRagTarget({
  mode,
  onCreated,
}: {
  mode: RagAlignmentMode;
  onCreated: (id: string) => void;
}) {
  return (
    <div className="space-y-3 py-4 text-sm text-slate-600">
      <p>
        还没有 RAG 评估对象，请新建或选择已有应用。
      </p>
      <RagTargetEntry mode={mode} onCreated={onCreated} />
      <RagTargetExplain />
    </div>
  );
}

/** 配置检查清单：每项就绪情况、是否必需、缺失时的影响。 */
export function ChecklistView({ checks }: { checks: RagConfigCheck[] }) {
  return (
    <ul
      aria-label="配置检查清单"
      className="divide-y divide-slate-100 rounded-lg border border-slate-200"
    >
      {checks.map((c) => (
        <li key={c.key} className="flex items-start gap-3 px-3 py-2 text-sm">
          <span
            className={`mt-0.5 w-12 shrink-0 text-xs font-medium ${
              c.ok
                ? 'text-severity-pass'
                : c.required
                  ? 'text-severity-critical'
                  : 'text-severity-high'
            }`}
          >
            {c.ok ? '就绪' : c.required ? '必需' : '未配置'}
          </span>
          <span className="flex-1">
            <span className="text-slate-800">{checkLabel(c.key, c.label)}</span>
            {!c.ok && checkHint(c.key) && <span className="block text-xs text-slate-500">{checkHint(c.key)}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function TargetCheckPanel({
  mode,
  selectedId,
  onSelect,
  onNext,
}: {
  mode: RagAlignmentMode;
  selectedId: string;
  onSelect: (id: string) => void;
  onNext: () => void;
}) {
  const targets = useRagTargets(mode);
  const probe = useTargetProbe(selectedId, mode);
  const list = targets.data ?? [];
  useEffect(() => {
    if (list.length && !list.some((t) => t.id === selectedId)) onSelect(list[0]!.id);
  }, [list, selectedId, onSelect]);
  const target: RagTarget | undefined = list.find((t) => t.id === selectedId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>1 · 选对象与试连（{MODE_DETAIL[mode].label}）</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {targets.isLoading ? (
          <LoadingBlock />
        ) : list.length === 0 ? (
          <NoRagTarget mode={mode} onCreated={onSelect} />
        ) : (
          <>
            <Field label="RAG 评估对象" htmlFor="rag-check-target">
              <Select
                id="rag-check-target"
                value={selectedId}
                onChange={(e) => onSelect(e.target.value)}
              >
                {list.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.isActive ? '' : '（已停用）'}
                  </option>
                ))}
              </Select>
            </Field>
            <RagTargetExplain />
            <RagTargetEntry mode={mode} onCreated={onSelect} />
            {target && (
              <>
                <div className="flex items-center gap-2 text-sm">
                  {target.ready ? (
                    <Badge tone="success">必需项已就绪</Badge>
                  ) : (
                    <Badge tone="danger">必需项未就绪，不能发起</Badge>
                  )}
                  <Link to="/model-targets" className="text-brand-600 hover:underline">
                    去评估对象修改配置
                  </Link>
                </div>
                <ChecklistView checks={target.checklist ?? []} />
                <ConnectionProbe id={selectedId} mode={mode} />
                <AutoUploadNotice
                  mode={mode}
                  uploadConfigured={Boolean(target.knowledgeUploadConfigured)}
                  deleteConfigured={Boolean(target.knowledgeDeleteConfigured)}
                  restrictedReady={Boolean(
                    target.restrictedKnowledgeBaseConfigured &&
                    target.restrictedCredentialConfigured,
                  )}
                />
              </>
            )}
            <Button onClick={onNext} disabled={!target?.ready || !probe.data?.ok || probe.isFetching || probe.isError}>
              下一步：知识对齐
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
