import { useTargetProbe } from './ConnectionProbe';
import { JudgeNotice } from './JudgeNotice';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ragEvalApi, type RagAlignmentMode } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { LoadingBlock } from '@/components/ui/spinner';
import { linkButton } from './labels';
import { errMsg } from './CreateTestSetModal';
import { MODE_DETAIL } from './ModeStep';
import { NoRagTarget, useRagTargets } from './TargetCheckPanel';
import { RunList } from './RunList';
import { RunResultView } from './RunResultView';
import { AutoUploadNotice } from './AutoUploadNotice';

export function RunPanel(props: {
  canRun: boolean;
  /** 可下载测试知识库包（含投毒/哨兵原文）。 */
  canManage?: boolean;
  mode: RagAlignmentMode;
  judgeConfigured: boolean;
  judgeMessage: string | null;
  corpusId: string;
  testSetId: string;
  targetId: string;
  onTestSetChange: (id: string) => void;
  onTargetChange: (id: string) => void;
  onGoStep: (s: number) => void;
}) {
  const { canRun, corpusId, testSetId, targetId, onTestSetChange, onTargetChange, onGoStep } =
    props;
  const toast = useToast();
  const qc = useQueryClient();
  const [confirmed, setConfirmed] = useState(false);
  const [pkgImported, setPkgImported] = useState(false);
  const [poisonImported, setPoisonImported] = useState(false);
  const [sentinelImported, setSentinelImported] = useState(false);
  const [viewRunId, setViewRunId] = useState('');

  const sets = useQuery({
    queryKey: ['rag-eval', 'test-sets', corpusId],
    queryFn: () => ragEvalApi.testSets(corpusId),
    enabled: !!corpusId,
  });
  const set = (sets.data ?? []).find((s) => s.id === testSetId);
  // 以测试集保存的对齐模式为准（第 1 步只决定新建测试集的默认值）。
  const mode: RagAlignmentMode = set?.alignmentMode ?? props.mode;
  const targets = useRagTargets(mode);
  const list = (targets.data ?? []).filter((t) => t.isActive);
  const target = list.find((t) => t.id === targetId);
  const probe = useTargetProbe(targetId, mode);
  const judge = useQuery({ queryKey: ['rag-eval', 'judge-check', targetId], queryFn: () => ragEvalApi.checkJudge(targetId), enabled: Boolean(targetId), retry: false, staleTime: 0 });
  useEffect(() => {
    if (list.length && !target) onTargetChange(list[0]!.id);
  }, [list, target, onTargetChange]);
  useEffect(() => {
    const l = sets.data ?? [];
    if (l.length && !l.some((s) => s.id === testSetId)) onTestSetChange(l[0]!.id);
  }, [sets.data, testSetId, onTestSetChange]);

  const create = useMutation({
    mutationFn: () =>
      ragEvalApi.createRun({
        testSetId,
        modelTargetId: targetId,
        alignmentConfirmed: mode !== 'TEST_PACKAGE' && confirmed,
        packageImported: mode === 'TEST_PACKAGE' && pkgImported,
        poisonDocumentImported: poisonImported,
        sentinelDocumentImported: sentinelImported,
      }),
    onSuccess: (r) => {
      toast.success('评估已发起');
      setViewRunId(r.id);
      void qc.invalidateQueries({ queryKey: ['rag-eval', 'runs'] });
    },
    onError: (e) => toast.error(errMsg(e, '发起失败')),
  });

  if (targets.isLoading || sets.isLoading) return <LoadingBlock />;
  const autoUpload = Boolean(target?.knowledgeUploadConfigured);
  const blockers: string[] = [];
  if (!set) blockers.push('未选择测试集（请选择测试集）');
  else if (set.generationStatus === 'GENERATING') blockers.push('测试集还在生成中');
  else if (set.itemCount === 0) blockers.push('测试集没有题目（请生成、导入或新增）');
  if (!target) blockers.push('没有可用的 RAG 评估对象（请返回试连）');
  else if (!target.ready) blockers.push('被测对象必需配置未就绪（见下方清单）');
  if (!probe.data?.ok || probe.isFetching || probe.isError) blockers.push('试连尚未通过，请先返回试连。');
  if (!canRun) blockers.push('当前账号没有发起 RAG 专项评估的权限');

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>5 · 运行（{MODE_DETAIL[mode].label}）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {(targets.data ?? []).length === 0 ? (
            <NoRagTarget mode={mode} onCreated={onTargetChange} />
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="测试集" htmlFor="rag-run-set" required>
                <Select
                  id="rag-run-set"
                  value={testSetId}
                  onChange={(e) => onTestSetChange(e.target.value)}
                >
                  {(sets.data ?? []).length === 0 && <option value="">暂无测试集</option>}
                  {(sets.data ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}（{s.itemCount} 题 · {s.alignmentModeLabel ?? ''}）
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="RAG 评估对象" htmlFor="rag-run-target" required>
                <Select
                  id="rag-run-target"
                  value={targetId}
                  onChange={(e) => onTargetChange(e.target.value)}
                >
                  {list.length === 0 && <option value="">无启用中的 RAG 对象</option>}
                  {list.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
          {target && (
            <AutoUploadNotice
              mode={mode}
              uploadConfigured={autoUpload}
              deleteConfigured={Boolean(target.knowledgeDeleteConfigured)}
              restrictedReady={Boolean(
                target.restrictedKnowledgeBaseConfigured && target.restrictedCredentialConfigured,
              )}
            />
          )}
          {target && (
            <div className="space-y-1.5 text-sm text-slate-700">
              {mode !== 'TEST_PACKAGE' && (
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  <span>
                    我确认：这些文档已在被测系统知识库中并完成索引（记录到审计日志；不确认则质量题记“未评估：未确认知识对齐”）
                  </span>
                </label>
              )}
              {mode === 'TEST_PACKAGE' && !autoUpload && (
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={pkgImported}
                    onChange={(e) => setPkgImported(e.target.checked)}
                  />
                  <span>
                    已把测试知识库包手工导入被测系统的测试知识库（未配置上传接口；不勾选则质量题记“未评估”）
                    {set && props.canManage && (
                      <button
                        type="button"
                        className={`ml-2 ${linkButton}`}
                        onClick={() =>
                          ragEvalApi
                            .downloadTestPackage(set.id)
                            .catch((e) => toast.error(errMsg(e, '下载失败')))
                        }
                      >
                        下载测试知识库包
                      </button>
                    )}
                  </span>
                </label>
              )}
              {!autoUpload && (
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={poisonImported}
                    onChange={(e) => setPoisonImported(e.target.checked)}
                  />
                  <span>已人工导入投毒测试文档（未导入则投毒、间接注入项记“未评估”）</span>
                </label>
              )}
              {!target.restrictedCredentialConfigured && (
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={sentinelImported}
                    onChange={(e) => setSentinelImported(e.target.checked)}
                  />
                  <span>
                    已把越权哨兵文档导入到当前测试身份无权访问的知识库（未导入则越权项记“未评估”）
                  </span>
                </label>
              )}
            </div>
          )}
          {(!judge.data?.available || judge.isError) && !judge.isFetching && (
            <JudgeNotice message={judge.data?.message ?? '判定模型当前不可用：探活失败，请重试。'} path="/settings#independent-judge-model" unavailable />
          )}
          {judge.isFetching && <p role="status" className="text-sm text-ink-3">正在检查判定模型…</p>}
          {!judge.data?.available && !judge.isFetching && <Button variant="outline" onClick={() => void judge.refetch()}>重新探活</Button>}
          {blockers.length > 0 && (
            <ul className="list-inside list-disc text-sm text-severity-critical">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-3">
            <Button
              disabled={blockers.length > 0 || create.isPending || !judge.data?.available || judge.isFetching || judge.isError}
              onClick={() => create.mutate()}
            >
              {create.isPending ? '发起中…' : '发起评估'}
            </Button>
            <button type="button" className={linkButton} onClick={() => onGoStep(4)}>
              返回试连
            </button>
          </div>
        </CardContent>
      </Card>
      <RunList onView={setViewRunId} canRun={canRun} />
      {viewRunId && <RunResultView runId={viewRunId} onClose={() => setViewRunId('')} />}
    </div>
  );
}
