import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { modelFilesApi } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { LoadingBlock } from '@/components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';

const TYPE_LABEL: Record<string, string> = {
  'machine-learning-model': '模型',
  data: '数据集',
  library: '依赖库',
};

const STATUS_LABEL: Record<string, string> = {
  PENDING: '排队中',
  RUNNING: '扫描中',
  COMPLETED: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
};

/** 最近一次关联扫描的结论：状态、高/中/低数量与完成时间。 */
function LatestScan({ targetId }: { targetId: string }) {
  const q = useQuery({
    queryKey: ['model-files', 'target-latest', targetId],
    queryFn: () => modelFilesApi.targetLatest(targetId),
  });
  if (q.isLoading || q.error) return null;
  const s = q.data;
  if (!s)
    return (
      <p className="text-sm text-muted-foreground">
        尚未扫描该对象的模型文件。可在
        <Link to="/inspect/model-files" className="mx-1 text-brand-600">
          模型文件扫描
        </Link>
        发起扫描并关联本对象。
      </p>
    );
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"
      aria-label="最近一次模型文件扫描"
    >
      <span>最近一次扫描：{STATUS_LABEL[s.status] ?? s.status}</span>
      {s.status === 'COMPLETED' && (
        <>
          <span>
            高危{' '}
            <b className="tabular-nums" style={{ color: s.highCount ? '#B42318' : undefined }}>
              {s.highCount}
            </b>
          </span>
          <span>
            中危{' '}
            <b className="tabular-nums" style={{ color: s.mediumCount ? '#B04A05' : undefined }}>
              {s.mediumCount}
            </b>
          </span>
          <span>
            低危{' '}
            <b className="tabular-nums" style={{ color: s.lowCount ? '#5B6778' : undefined }}>
              {s.lowCount}
            </b>
          </span>
          {s.truncatedCount > 0 && <span className="text-severity-high">部分结果</span>}
        </>
      )}
      {s.status === 'FAILED' && <span className="text-severity-critical">{s.error}</span>}
      <span className="text-muted-foreground">{formatDateTime(s.finishedAt ?? s.createdAt)}</span>
    </div>
  );
}

/** 评估对象的模型文件区块：最近一次扫描结论 + 最近一次完成扫描生成的 CycloneDX 1.6 ML-BOM。 */
export function TargetAibomSection({ targetId }: { targetId: string }) {
  return (
    <div className="space-y-3">
      <LatestScan targetId={targetId} />
      <TargetAibom targetId={targetId} />
    </div>
  );
}

function TargetAibom({ targetId }: { targetId: string }) {
  const q = useQuery({
    queryKey: ['model-files', 'target-aibom', targetId],
    queryFn: () => modelFilesApi.targetAibom(targetId),
  });
  if (q.isLoading) return <LoadingBlock label="正在加载 AIBOM…" />;
  if (q.error) return <p className="text-sm text-muted-foreground">AIBOM 加载失败</p>;
  const data = q.data;
  if (!data) return null;
  const prop = (c: { properties?: Array<{ name: string; value: string }> }, n: string) =>
    c.properties?.find((p) => p.name === n)?.value;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 text-sm">
        <span>CycloneDX {data.aibom.specVersion}</span>
        <span className="text-muted-foreground">生成于 {formatDateTime(data.createdAt)}</span>
        <button
          type="button"
          className="text-brand-600"
          onClick={() => void modelFilesApi.exportAibom(data.scanId)}
        >
          导出 JSON
        </button>
      </div>
      <Table>
        <THead>
          <TR>
            <TH>类型</TH>
            <TH>名称</TH>
            <TH>格式 / 版本</TH>
            <TH>SHA-256</TH>
            <TH>许可</TH>
            <TH>参数量</TH>
          </TR>
        </THead>
        <TBody>
          {data.aibom.components.map((c, i) => (
            <TR key={`${c.name}-${i}`}>
              <TD>{TYPE_LABEL[c.type] ?? c.type}</TD>
              <TD className="break-all">{c.name}</TD>
              <TD>{prop(c, 'lse:format') ?? c.version ?? '—'}</TD>
              <TD className="font-mono text-xs">
                {c.hashes?.find((h) => h.alg === 'SHA-256')?.content.slice(0, 16) ?? '—'}
              </TD>
              <TD>{c.licenses?.map((l) => l.license.id ?? l.license.name).join('、') || '—'}</TD>
              <TD className="tabular-nums">{prop(c, 'lse:parameterCount') ?? '—'}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
