import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type GbtMeasureItem } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { LoadingBlock } from '@/components/ui/spinner';
import type { BadgeTone } from '@/lib/format';

const VERDICTS: Array<{ value: string; label: string; tone: BadgeTone }> = [
  { value: 'conform', label: '符合', tone: 'success' },
  { value: 'nonconform', label: '不符合', tone: 'critical' },
  { value: 'not_applicable', label: '不适用', tone: 'neutral' },
];

const GB45438_ID = 'gb45438.explicit';
const ABUSE_ID = 'gbt45654.abuse-handling';

interface AbuseEvidence {
  turns: Array<{ index: number; kind: string; prompt: string; response: string | null; httpStatus: number | null; error: string | null }>;
  analysis: { hint: string };
  takenAt: string;
}
interface LabelEvidence {
  checked: number;
  labeled: number;
  ratioPercent: number | null;
  note: string;
}

function EvidenceView({ item }: { item: GbtMeasureItem }) {
  if (!item.evidence) return null;
  if (item.clauseId === ABUSE_ID) {
    const ev = item.evidence as AbuseEvidence;
    return (
      <div className="space-y-2 rounded-md bg-slate-50 p-3 text-xs text-slate-700">
        <div>{item.finding?.text ?? ev.analysis?.hint}</div>
        <details>
          <summary className="cursor-pointer text-slate-500">查看 6 轮对话记录</summary>
          <ol className="mt-2 space-y-2">
            {ev.turns.map((t) => (
              <li key={t.index}>
                <div className="font-medium">
                  第 {t.index} 轮（{t.kind === 'abuse' ? '违规输入' : '正常问题'}）：{t.prompt}
                </div>
                <div className="text-slate-600">
                  {t.response ?? `没有取得回答${t.error ? `：${t.error}` : ''}`}
                  {t.httpStatus ? `（HTTP ${t.httpStatus}）` : ''}
                </div>
              </li>
            ))}
          </ol>
        </details>
      </div>
    );
  }
  if (item.clauseId === GB45438_ID) {
    const ev = item.evidence as LabelEvidence;
    return (
      <div className="rounded-md bg-slate-50 p-3 text-xs text-slate-700">
        {item.finding?.text ??
          `检查 ${ev.checked} 条文本回答，其中 ${ev.labeled} 条带「由人工智能生成」一类提示。`}
      </div>
    );
  }
  return null;
}

function MeasureCard({ runId, item, canRun, canJudge }: { runId: string; item: GbtMeasureItem; canRun: boolean; canJudge: boolean }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [verdict, setVerdict] = useState(item.verdict ?? '');
  const [note, setNote] = useState(item.note ?? '');
  const [materials, setMaterials] = useState(item.materials ?? '');
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['gbt-measures', runId] });
    void queryClient.invalidateQueries({ queryKey: ['gbt-state', runId] });
  };

  const collect = useMutation({
    mutationFn: () =>
      item.clauseId === ABUSE_ID
        ? api.standardEvaluations.gbtAbuseProbe(runId)
        : api.standardEvaluations.gbtExplicitLabel(runId),
    onSuccess: () => {
      toast.success('已重新取证，结论已更新。');
      setVerdict('');
      refresh();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : '取证失败'),
  });
  const save = useMutation({
    mutationFn: () =>
      api.standardEvaluations.gbtConfirmMeasure(runId, item.clauseId, {
        verdict,
        note: note.trim() || null,
        materials: materials.trim() || null,
      }),
    onSuccess: () => {
      toast.success('已保存。');
      refresh();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : '保存失败'),
  });

  const confirmed = VERDICTS.find((v) => v.value === item.verdict);
  const probe = item.kind === 'PROBE';
  const auto = probe && !confirmed ? item.finding : null;
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="text-sm font-medium text-slate-900">{item.title}</div>
            <div className="text-xs text-slate-500">{item.ref}</div>
          </div>
          {confirmed ? (
            <Badge tone={confirmed.tone}>{confirmed.label}</Badge>
          ) : auto?.status === 'conform' ? (
            <Badge tone="success">符合</Badge>
          ) : auto?.status === 'observe' ? (
            <Badge tone="warning">提示项</Badge>
          ) : probe ? (
            <Badge tone="neutral">未取证</Badge>
          ) : (
            <Badge tone="neutral">未填</Badge>
          )}
        </div>
        <p className="text-xs leading-5 text-slate-600">{item.requirement}</p>
        {item.clauseId === GB45438_ID && (
          <p className="text-xs text-slate-500">依据 GB 45438-2025 显式标识要求，条款号待核。</p>
        )}
        {probe && (
          <div className="space-y-2">
            <Button size="sm" variant="outline" disabled={!canRun || collect.isPending} onClick={() => collect.mutate()}>
              {collect.isPending ? '取证中…' : item.hasEvidence ? '重新取证' : '平台取证'}
            </Button>
            <EvidenceView item={item} />
          </div>
        )}
        {auto?.advice && <p className="text-xs leading-5 text-amber-700">建议：{auto.advice}</p>}
        {(!probe || item.hasEvidence) && (
          <details className="border-t border-slate-200 pt-3" open={!probe}>
            <summary className={probe ? 'cursor-pointer text-xs text-slate-500' : 'hidden'}>复核人改判（可选）</summary>
          <div className="space-y-2 pt-2">
            <div className="flex flex-wrap gap-3" role="radiogroup" aria-label={`${item.title}结论`}>
              {VERDICTS.map((v) => (
                <label key={v.value} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="radio"
                    name={`verdict-${item.clauseId}`}
                    value={v.value}
                    checked={verdict === v.value}
                    onChange={() => setVerdict(v.value)}
                    disabled={!canJudge}
                  />
                  {v.label}
                </label>
              ))}
            </div>
            <Textarea
              aria-label="说明"
              placeholder="说明（选填）"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={!canJudge}
            />
            <Input
              aria-label="证明材料备注"
              placeholder="证明材料备注（选填）"
              value={materials}
              onChange={(e) => setMaterials(e.target.value)}
              disabled={!canJudge}
            />
            <div className="flex items-center gap-3">
              <Button size="sm" disabled={!canJudge || !verdict || save.isPending} onClick={() => save.mutate()}>
                保存
              </Button>
              {item.confirmedByName && (
                <span className="text-xs text-slate-500">
                  {item.confirmedByName} 于 {item.confirmedAt ? new Date(item.confirmedAt).toLocaleString('zh-CN') : ''} 确认
                </span>
              )}
            </div>
          </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

/** 安全措施核验：违规输入处置与显式标识在评估结束时由平台自动取证并出结论，复核人可改判；其余管理措施有材料时由复核人填报，填了才计入报告。 */
export function StandardMeasuresPage() {
  const { runId = '' } = useParams();
  const { hasPermission } = useAuth();
  const list = useQuery({
    queryKey: ['gbt-measures', runId],
    queryFn: () => api.standardEvaluations.gbtMeasures(runId),
    enabled: runId !== '',
  });
  const canRun = hasPermission('standard_eval:run');
  const canJudge = hasPermission('standard_review:judge');
  const probes = list.data?.items.filter((i) => i.kind === 'PROBE') ?? [];
  const forms = list.data?.items.filter((i) => i.kind === 'FORM') ?? [];

  return (
    <div>
      <PageHeader
        title="安全措施核验"
        description="违规输入处置与生成内容显式标识在评估结束时由平台自动取证并出结论。其余是服务提供者的管理措施，接口测不到；有服务提供者材料时可在下面填报，填了才计入报告。"
        actions={
          <Link to="/eval-tasks">
            <Button variant="outline" size="sm">
              返回评估任务
            </Button>
          </Link>
        }
      />
      {list.isLoading && <LoadingBlock label="正在加载…" />}
      {list.data && (
        <div className="space-y-6">
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-slate-900">平台自动取证</h2>
            {probes.map((item) => (
              <MeasureCard key={item.clauseId} runId={runId} item={item} canRun={canRun} canJudge={canJudge} />
            ))}
          </section>
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-slate-900">服务提供者材料（可选填报）</h2>
            {forms.map((item) => (
              <MeasureCard key={item.clauseId} runId={runId} item={item} canRun={canRun} canJudge={canJudge} />
            ))}
          </section>
        </div>
      )}
    </div>
  );
}
