import type { ReactNode } from 'react';
import type { RagEvalResult } from '@/lib/api';
import { Modal } from '@/components/ui/modal';
import { ragTypeLabel } from './labels';
import { CitationItem, EvidenceBlock, citationEntries, contextGroups } from './Evidence';

const NE_LABEL: Record<string, string> = {
  correctness: '正确性',
  faithfulness: '忠实度',
  citation: '引用准确性',
  refusal: '拒答',
  retrieval: '检索命中',
  security: '安全判定',
};

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1">
      <h4 className="text-xs font-semibold text-slate-700">{title}</h4>
      {children}
    </section>
  );
}

function score(v: number | null | undefined) {
  return v == null ? '未评估' : v.toFixed(2);
}

/** 单题下钻：问题、参考答案、回复、被测上下文、引用、各项分数与未评估原因。 */
export function ResultDrill({ r, onClose }: { r: RagEvalResult; onClose: () => void }) {
  const groups = contextGroups(r.retrievedContext);
  const ctxCount = groups.reduce((n, g) => n + g.entries.length, 0);
  const cites = citationEntries(r.citations);
  const ne = Object.entries(r.notEvaluated ?? {});
  return (
    <Modal open onClose={onClose} title={`单题详情 · ${ragTypeLabel(r.itemType)}`} size="xl">
      <div className="space-y-3 text-sm">
        <Block title="问题">
          <p className="whitespace-pre-wrap">{r.question}</p>
        </Block>
        <Block title="参考答案">
          <p className="whitespace-pre-wrap text-slate-600">
            {r.referenceAnswer ?? '—（无答案题/安全题）'}
          </p>
        </Block>
        <Block title="被测回复">
          <p className="whitespace-pre-wrap break-all text-slate-700">
            {r.response ?? r.errorMessage ?? '—'}
          </p>
        </Block>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-600">
          <span>正确性：{score(r.correctness)}</span>
          <span>忠实度：{score(r.faithfulness)}</span>
          <span>引用准确性：{score(r.citationAccuracy)}</span>
          <span>拒答：{r.refusalOk == null ? '未评估' : r.refusalOk ? '正确拒答' : '未拒答'}</span>
          {r.retrievalEvaluated && <span>检索命中名次：{r.retrievalRank ?? '未命中'}</span>}
          {r.latencyMs != null && <span>耗时：{r.latencyMs} ms</span>}
          {r.needsReview && <span className="text-severity-high">需人工复核</span>}
        </div>
        {r.reason && (
          <Block title="判定说明">
            <p className="text-slate-600">{r.reason}</p>
          </Block>
        )}
        {ne.length > 0 && (
          <Block title="未评估项">
            <ul className="list-inside list-disc text-xs text-slate-500">
              {ne.map(([k, v]) => (
                <li key={k}>
                  {NE_LABEL[k] ?? k}：{v}
                </li>
              ))}
            </ul>
          </Block>
        )}
        <Block title={`被测系统检索上下文（${ctxCount}）`}>
          {ctxCount === 0 ? (
            <p className="text-xs text-slate-500">
              未取到（未配置检索上下文路径或响应中没有该字段）
            </p>
          ) : (
            <div className="max-h-72 space-y-2 overflow-y-auto">
              {groups
                .filter((g) => g.entries.length > 0)
                .map((g, gi) => (
                  <div key={gi} className="space-y-1">
                    {g.title && (
                      <p className="text-xs text-slate-500">
                        {g.title}（{g.entries.length}）
                      </p>
                    )}
                    <ol className="space-y-1">
                      {g.entries.map((e, i) => (
                        <EvidenceBlock key={i} e={e} index={i} />
                      ))}
                    </ol>
                  </div>
                ))}
            </div>
          )}
        </Block>
        <Block title={`引用来源（${cites.length}）`}>
          {cites.length === 0 ? (
            <p className="text-xs text-slate-500">未返回引用（空引用不计分）</p>
          ) : (
            <ol className="max-h-40 list-inside list-decimal space-y-1 overflow-y-auto">
              {cites.map((e, i) => (
                <CitationItem key={i} e={e} index={i} />
              ))}
            </ol>
          )}
        </Block>
      </div>
    </Modal>
  );
}
