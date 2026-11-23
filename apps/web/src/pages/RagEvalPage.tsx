import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ragEvalApi, type RagAlignmentMode } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';
import { LoadingBlock } from '@/components/ui/spinner';
import { CorpusPanel } from './rag-eval/CorpusPanel';
import { TestSetPanel } from './rag-eval/TestSetPanel';
import { TargetCheckPanel } from './rag-eval/TargetCheckPanel';
import { RunPanel } from './rag-eval/RunPanel';
import { ModeStep } from './rag-eval/ModeStep';
import { JudgeNotice } from './rag-eval/JudgeNotice';

export const RAG_STEPS = [
  { key: 4, label: '选对象与试连' },
  { key: 1, label: '知识对齐' },
  { key: 2, label: '测试文档' },
  { key: 3, label: '选测试集' },
  { key: 5, label: '运行与结果' },
] as const;

function StepBar({ step, onStep }: { step: number; onStep: (s: number) => void }) {
  return (
    <ol
      aria-label="评估步骤"
      className="flex flex-wrap items-center gap-x-1 gap-y-2 rounded-card border border-line bg-white px-4 py-3 text-sm shadow-card"
    >
      {RAG_STEPS.map((s, i) => {
        const active = s.key === step;
        const done = i < RAG_STEPS.findIndex(item => item.key === step);
        return (
          <li key={s.key} className="flex items-center gap-1">
            <button
              type="button"
              aria-current={active ? 'step' : undefined}
              onClick={() => onStep(s.key)}
              className={`flex items-center gap-2 rounded-full px-3 py-1.5 transition-colors ${
                active
                  ? 'bg-brand-50 font-semibold text-brand-700'
                  : done
                    ? 'text-brand-600 hover:bg-canvas'
                    : 'text-ink-3 hover:bg-canvas'
              }`}
            >
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full text-xs font-semibold ${
                  active
                    ? 'bg-brand-600 text-white'
                    : done
                      ? 'bg-brand-100 text-brand-700'
                      : 'bg-severity-unknown-bg text-ink-3'
                }`}
              >
                {i + 1}
              </span>
              <span>{s.label}</span>
            </button>
            {i < RAG_STEPS.length - 1 && <span className="mx-1 h-px w-6 bg-line-2" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

export function RagEvalPage() {
  const { hasPermission } = useAuth();
  const canRead = hasPermission('rag_eval:read');
  const canManage = hasPermission('rag_eval:manage');
  const canRun = hasPermission('rag_eval:run');
  const [step, setStep] = useState(4);
  const [mode, setMode] = useState<RagAlignmentMode>('KB_EXISTING');
  const [corpusId, setCorpusId] = useState('');
  const [testSetId, setTestSetId] = useState('');
  const [targetId, setTargetId] = useState('');

  const status = useQuery({
    queryKey: ['rag-eval', 'status'],
    queryFn: ragEvalApi.status,
    enabled: canRead,
  });
  const judgeCheck = useQuery({
    queryKey: ['rag-eval', 'judge-check', targetId],
    queryFn: () => ragEvalApi.checkJudge(targetId || undefined),
    enabled: canRead && status.data?.judgeConfigured === false && step !== 5,
    retry: false,
  });
  const corpora = useQuery({
    queryKey: ['rag-eval', 'corpora'],
    queryFn: ragEvalApi.corpora,
    enabled: canRead,
  });

  useEffect(() => {
    const first = corpora.data?.[0];
    if (!corpusId && first) setCorpusId(first.id);
  }, [corpora.data, corpusId]);

  if (!canRead) {
    return (
      <div className="space-y-5">
        <PageHeader title="RAG 专项评估" />
        <p className="text-sm text-ink-3">当前账号没有查看 RAG 专项评估的权限。</p>
      </div>
    );
  }
  if (status.isLoading) return <LoadingBlock />;

  const judgeConfigured = status.data?.judgeConfigured ?? false;
  const judgeMessage = status.data?.message ?? null;
  const judgePath = status.data?.judgeSettingsPath ?? '/settings#independent-judge-model';
  const corpusName = corpora.data?.find((c) => c.id === corpusId)?.name ?? null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="RAG 专项评估"
      />
      <StepBar step={step} onStep={setStep} />
      {!judgeConfigured && step !== 5 && <JudgeNotice message={judgeCheck.data?.message ?? judgeMessage} path={judgePath} />}
      {step === 1 && <ModeStep mode={mode} onChange={setMode} onNext={() => setStep(2)} />}
      {step === 2 && (
        <CorpusPanel
          canManage={canManage}
          maxBytes={status.data?.maxDocumentBytes ?? 10 * 1024 * 1024}
          selectedId={corpusId}
          onSelect={setCorpusId}
        />
      )}
      {step === 3 && (
        <TestSetPanel
          canManage={canManage}
          corpusId={corpusId}
          corpusName={corpusName}
          mode={mode}
          judgeConfigured={judgeConfigured}
          judgeMessage={judgeMessage}
          selectedId={testSetId}
          onSelect={setTestSetId}
          onGoStep={setStep}
        />
      )}
      {step === 4 && (
        <TargetCheckPanel
          mode={mode}
          selectedId={targetId}
          onSelect={setTargetId}
          onNext={() => setStep(1)}
        />
      )}
      {step === 5 && (
        <RunPanel
          canRun={canRun}
          canManage={canManage}
          mode={mode}
          judgeConfigured={judgeConfigured}
          judgeMessage={judgeMessage}
          corpusId={corpusId}
          testSetId={testSetId}
          targetId={targetId}
          onTestSetChange={setTestSetId}
          onTargetChange={setTargetId}
          onGoStep={setStep}
        />
      )}
    </div>
  );
}
