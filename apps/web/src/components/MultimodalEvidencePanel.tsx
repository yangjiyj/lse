import { useEffect, useState } from 'react';
import { api, fetchMultimodalImageUrl, type MultimodalEvidence } from '@/lib/api';
import { Button } from '@/components/ui/button';

const VERDICT_LABEL: Record<string, string> = {
  PASS: '未越狱（通过）',
  FAIL: '越狱成功（风险）',
  UNKNOWN: '无法判定',
  ERROR: '判定异常',
};
const VERDICT_COLOR: Record<string, string> = {
  PASS: '#1B7A46',
  FAIL: '#B42318',
  UNKNOWN: '#5B6778',
  ERROR: '#B04A05',
};

/** 结果详情：展示多模态越狱存证图片（带鉴权拉取）、攻击构成与判定模型结论。 */
export function MultimodalEvidencePanel({
  taskId,
  resultId,
  evidence,
}: {
  taskId: string;
  resultId: string;
  evidence: MultimodalEvidence;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    fetchMultimodalImageUrl(taskId, resultId)
      .then((u) => {
        if (revoked) URL.revokeObjectURL(u);
        else {
          objectUrl = u;
          setUrl(u);
        }
      })
      .catch(() => !revoked && setFailed(true));
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [taskId, resultId]);

  const [removed, setRemoved] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const removeImages = async () => {
    if (!window.confirm('确认删除本次评估使用的全部自带图片？删除后无法恢复，评估结论仍会保留。'))
      return;
    setRemoving(true);
    try {
      const r = await api.evalTasks.deleteTaskByoImages(taskId);
      setRemoved(`已删除 ${r.deleted} 张图片`);
      setUrl(null);
      setFailed(true);
    } catch {
      setRemoved('删除失败，请稍后重试');
    } finally {
      setRemoving(false);
    }
  };
  const byo = evidence.byo ?? null;
  const verdict = evidence.judge?.verdict ?? null;
  return (
    <div aria-label="多模态越狱证据" className="space-y-3">
      <div className="text-xs font-medium text-muted-foreground">
        {byo ? '多模态 · ' : '多模态越狱 · '}
        {evidence.attackLabel || evidence.attackType}
      </div>
      <div className="rounded-md border border-border bg-muted/40 p-2">
        {url ? (
          <img
            src={url}
            alt={`多模态越狱攻击图片（${evidence.attackLabel}）`}
            width={evidence.image.width}
            height={evidence.image.height}
            className="h-auto max-w-full"
          />
        ) : (
          <p className="p-4 text-center text-xs text-muted-foreground">
            {failed ? (byo ? '图片已删除或无权查看' : '存证图片读取失败') : '正在读取存证图片…'}
          </p>
        )}
      </div>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">随图文字</dt>
        <dd className="break-words">{evidence.text}</dd>
        {evidence.injectedText && (
          <>
            <dt className="text-muted-foreground">角落注入</dt>
            <dd className="break-words">{evidence.injectedText}</dd>
          </>
        )}
        {byo && (
          <>
            <dt className="text-muted-foreground">图片类别</dt>
            <dd className="break-words">{byo.category || '未分类'}</dd>
            <dt className="text-muted-foreground">期望处置</dt>
            <dd>{byo.expected}</dd>
            {byo.note && (
              <>
                <dt className="text-muted-foreground">备注</dt>
                <dd className="break-words">{byo.note}</dd>
              </>
            )}
          </>
        )}
        <dt className="text-muted-foreground">图片 sha256</dt>
        <dd className="break-all font-mono">{evidence.image.sha256}</dd>
        {!byo && (
          <>
            <dt className="text-muted-foreground">生成种子</dt>
            <dd className="break-all font-mono">{evidence.seed}</dd>
          </>
        )}
        <dt className="text-muted-foreground">判定模型结论</dt>
        <dd>
          {verdict ? (
            <span style={{ color: VERDICT_COLOR[verdict] ?? '#5B6778' }}>
              {VERDICT_LABEL[verdict] ?? verdict}
            </span>
          ) : (
            <span className="text-muted-foreground">{evidence.error ?? '暂无判定'}</span>
          )}
        </dd>
        {evidence.judge?.evidence && (
          <>
            <dt className="text-muted-foreground">判定理由</dt>
            <dd className="whitespace-pre-wrap break-words">{evidence.judge.evidence}</dd>
          </>
        )}
      </dl>
      {byo && (
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" disabled={removing} onClick={removeImages}>
            删除本评估的自带图片
          </Button>
          {removed && <span className="text-xs text-muted-foreground">{removed}</span>}
        </div>
      )}
    </div>
  );
}
