import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  modelFingerprintApi,
  type FingerprintComponentKey,
  type FingerprintSource,
  type ModelFingerprintComparison,
} from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { LoadingBlock, Spinner } from '@/components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';

export const FINGERPRINT_TARGET_TYPES = ['MODEL', 'AGENT_API', 'PUBLIC_AGENT'];

const SOURCE_LABEL: Record<FingerprintSource, string> = {
  MANUAL: '手动',
  PRE_TASK: '任务前自动',
};

const COMPONENT_LABEL: Record<FingerprintComponentKey, string> = {
  ngram: '文本相似度（n-gram）',
  length: '回复长度',
  refusal: '拒答行为',
  format: '输出格式',
  identity: '自述身份',
};

const COMPONENT_ORDER: FingerprintComponentKey[] = [
  'ngram',
  'length',
  'refusal',
  'format',
  'identity',
];

export function formatSimilarity(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '—';
}

const linkCls = 'text-brand-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50';

function ComparisonView({ data }: { data: ModelFingerprintComparison }) {
  return (
    <section aria-label="比对结果" className="space-y-2 rounded-md border border-slate-200 p-3">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
        <span>
          总相似度{' '}
          <span className="font-semibold tabular-nums">{formatSimilarity(data.similarity)}</span>
        </span>
        <span>
          阈值 <span className="tabular-nums">{formatSimilarity(data.threshold)}</span>
        </span>
        <span>
          结论{' '}
          {data.drift ? (
            <span className="font-semibold text-severity-critical">疑似模型被替换</span>
          ) : (
            <span className="font-semibold">一致</span>
          )}
        </span>
        <span className="text-xs text-muted-foreground">比对探针 {data.comparedProbes} 条</span>
      </div>
      <Table>
        <THead>
          <TR>
            <TH>分项</TH>
            <TH>分值</TH>
            <TH>权重</TH>
          </TR>
        </THead>
        <TBody>
          {COMPONENT_ORDER.map((k) => (
            <TR key={k}>
              <TD>{COMPONENT_LABEL[k]}</TD>
              <TD className="tabular-nums">{formatSimilarity(data.components?.[k])}</TD>
              <TD className="tabular-nums">{formatSimilarity(data.weights?.[k])}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </section>
  );
}

/** 评估对象的模型指纹区块：采集、历史、设为基线、与基线比对。 */
export function TargetFingerprintSection({
  targetId,
  canUpdate,
}: {
  targetId: string;
  canUpdate: boolean;
}) {
  const qc = useQueryClient();
  const listKey = ['model-fingerprints', targetId];
  const [compareId, setCompareId] = useState<string | null>(null);
  const [collectError, setCollectError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: listKey,
    queryFn: () => modelFingerprintApi.list(targetId, 20),
  });
  const baselineId = list.data?.baselineId ?? null;
  const threshold = list.data?.defaultThreshold;

  const compare = useQuery({
    queryKey: ['model-fingerprints', targetId, 'compare', baselineId, compareId, threshold],
    queryFn: () =>
      modelFingerprintApi.compare(targetId, {
        a: baselineId!,
        b: compareId!,
        ...(threshold !== undefined ? { threshold } : {}),
      }),
    enabled: Boolean(baselineId && compareId),
    retry: false,
  });

  const collect = useMutation({
    mutationFn: () => modelFingerprintApi.collect(targetId),
    onMutate: () => setCollectError(null),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
    onError: (err) => setCollectError(err instanceof Error ? err.message : '指纹采集失败'),
  });

  const setBaseline = useMutation({
    mutationFn: (fpId: string) => modelFingerprintApi.setBaseline(targetId, fpId),
    onMutate: () => setActionError(null),
    onSuccess: () => {
      setCompareId(null);
      return qc.invalidateQueries({ queryKey: listKey });
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : '设为基线失败'),
  });

  if (list.isLoading) return <LoadingBlock label="正在加载模型指纹…" />;
  if (list.error)
    return (
      <p className="text-sm text-severity-critical">
        {list.error instanceof Error ? list.error.message : '模型指纹加载失败'}
      </p>
    );
  const items = list.data?.items ?? [];

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">平台内部指纹比对，非模型身份认证结论</p>

      {canUpdate && (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={collect.isPending} onClick={() => collect.mutate()}>
            {collect.isPending ? <Spinner className="h-3.5 w-3.5" /> : null}
            采集指纹
          </Button>
          <span className="text-xs text-muted-foreground">
            采集会向被测对象发送 {list.data?.probes?.length || 10} 次请求
          </span>
        </div>
      )}
      {collectError && (
        <p role="alert" className="text-sm text-severity-critical">
          {collectError}
        </p>
      )}
      {actionError && (
        <p role="alert" className="text-sm text-severity-critical">
          {actionError}
        </p>
      )}

      {!baselineId && (
        <p className="text-sm text-muted-foreground">尚未设置基线，任务执行前不会比对</p>
      )}

      {items.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">暂无指纹记录</p>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>采集时间</TH>
              <TH>来源</TH>
              <TH>采集人</TH>
              <TH>是否基线</TH>
              <TH>操作</TH>
            </TR>
          </THead>
          <TBody>
            {items.map((fp) => (
              <TR key={fp.id}>
                <TD className="tabular-nums">{formatDateTime(fp.createdAt)}</TD>
                <TD>{SOURCE_LABEL[fp.source] ?? fp.source}</TD>
                <TD>{fp.createdByName ?? '—'}</TD>
                <TD>{fp.isBaseline ? '是' : '否'}</TD>
                <TD>
                  <div className="flex flex-wrap gap-3 text-sm">
                    {canUpdate && !fp.isBaseline && (
                      <button
                        type="button"
                        className={linkCls}
                        disabled={setBaseline.isPending}
                        onClick={() => setBaseline.mutate(fp.id)}
                      >
                        设为基线
                      </button>
                    )}
                    {baselineId && !fp.isBaseline && (
                      <button type="button" className={linkCls} onClick={() => setCompareId(fp.id)}>
                        与基线对比
                      </button>
                    )}
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      {compareId && baselineId && (
        <>
          {compare.isLoading && <LoadingBlock label="正在比对…" />}
          {compare.error && (
            <p role="alert" className="text-sm text-severity-critical">
              {compare.error instanceof Error ? compare.error.message : '比对失败'}
            </p>
          )}
          {compare.data && <ComparisonView data={compare.data} />}
        </>
      )}
    </div>
  );
}
