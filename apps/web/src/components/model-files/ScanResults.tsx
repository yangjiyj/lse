import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  modelFilesApi,
  type ModelFileIdentification,
  type ModelFileKnownModel,
  type ModelFileScanRecord,
} from '@/lib/api';
import { formatDateTime, severityLabel } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { LoadingBlock } from '@/components/ui/spinner';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatBytes } from './format';

const RISK_COLOR: Record<string, string> = {
  CRITICAL: '#B42318',
  HIGH: '#B42318',
  MEDIUM: '#B04A05',
  LOW: '#5B6778',
  INFO: '#5B6778',
};
const FORMAT_LABEL: Record<string, string> = {
  pickle: 'Pickle',
  'pytorch-zip': 'PyTorch（zip）',
  safetensors: 'safetensors',
  gguf: 'GGUF',
  onnx: 'ONNX',
  keras: 'Keras 3',
  'keras-h5': 'Keras H5',
  numpy: 'NumPy（npy/npz）',
  zip: 'ZIP 压缩包',
  config: '配置文件',
  'office-macro': 'Office 宏文档',
  python: 'Python',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  shell: 'Shell',
  powershell: 'PowerShell',
  batch: '批处理',
  vbscript: 'VBScript',
  vba: 'VBA 宏',
  unknown: '未识别',
};
export const SOURCE_LABEL = { UPLOAD: '上传扫描', DIRECTORY: '目录扫描' } as const;
const STATUS: Record<ModelFileScanRecord['status'], { label: string; color: string }> = {
  PENDING: { label: '排队中', color: '#5B6778' },
  RUNNING: { label: '扫描中', color: '#1F57E0' },
  COMPLETED: { label: '已完成', color: '#1B7A46' },
  FAILED: { label: '失败', color: '#B42318' },
  CANCELLED: { label: '已取消', color: '#5B6778' },
};
const active = (s: { status: string }) => s.status === 'PENDING' || s.status === 'RUNNING';

function Progress({ s }: { s: ModelFileScanRecord }) {
  if (s.status === 'PENDING') return <>排队中，等待后台开始扫描</>;
  const pct =
    s.plannedBytes > 0 ? Math.min(100, Math.floor((s.progressBytes / s.plannedBytes) * 100)) : 0;
  return (
    <>
      已扫 <span className="tabular-nums">{s.progressFiles}</span>/
      <span className="tabular-nums">{s.plannedFiles}</span> 个文件，
      {formatBytes(s.progressBytes)}/{formatBytes(s.plannedBytes)}（{pct}%）
    </>
  );
}

function CancelButton({ id }: { id: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => modelFilesApi.cancel(id),
    onSuccess: () => {
      toast.success('已取消');
      void qc.invalidateQueries({ queryKey: ['model-files'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : '取消失败'),
  });
  return (
    <button
      type="button"
      className="text-severity-critical"
      disabled={m.isPending}
      onClick={() => m.mutate()}
    >
      取消
    </button>
  );
}

function Count({ n, color }: { n: number; color: string }) {
  return (
    <span className="tabular-nums" style={{ color: n > 0 ? color : undefined }}>
      {n}
    </span>
  );
}

export function ScanList({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['model-files', 'scans', page],
    queryFn: () => modelFilesApi.list({ page, pageSize: 10 }),
    refetchInterval: (q) => ((q.state.data?.items ?? []).some(active) ? 2000 : false),
  });
  if (list.isLoading) return <LoadingBlock label="正在加载扫描记录…" />;
  if (list.error)
    return (
      <p className="text-sm text-severity-critical">
        {list.error instanceof ApiError ? list.error.message : '扫描记录加载失败'}
      </p>
    );
  const items = list.data?.items ?? [];
  if (!items.length)
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        还没有扫描记录。在上方选择「上传扫描」或「目录扫描」发起第一次扫描。
      </p>
    );
  return (
    <>
      <Table>
        <THead>
          <TR>
            <TH>时间</TH>
            <TH>方式</TH>
            <TH>路径 / 文件</TH>
            <TH>评估对象</TH>
            <TH>状态</TH>
            <TH className="text-right">文件数</TH>
            <TH className="text-right">高危</TH>
            <TH className="text-right">中危</TH>
            <TH className="text-right">低危</TH>
            <TH>操作</TH>
          </TR>
        </THead>
        <TBody>
          {items.map((s) => (
            <TR key={s.id} className={selected === s.id ? 'bg-brand-50' : undefined}>
              <TD className="tabular-nums">{formatDateTime(s.createdAt)}</TD>
              <TD>{SOURCE_LABEL[s.source]}</TD>
              <TD className="max-w-[280px] truncate font-mono text-xs" title={s.path}>
                {s.path}
              </TD>
              <TD>{s.target?.name ?? '—'}</TD>
              <TD>
                <span style={{ color: STATUS[s.status].color }} title={s.error ?? ''}>
                  {STATUS[s.status].label}
                </span>
                {s.status === 'COMPLETED' && s.truncatedCount > 0 && (
                  <span className="ml-1 text-xs text-severity-high" title={s.truncatedReason ?? ''}>
                    部分结果
                  </span>
                )}
              </TD>
              <TD className="text-right tabular-nums">{s.fileCount}</TD>
              <TD className="text-right">
                <Count n={s.highCount} color="#B42318" />
              </TD>
              <TD className="text-right">
                <Count n={s.mediumCount} color="#B04A05" />
              </TD>
              <TD className="text-right">
                <Count n={s.lowCount} color="#5B6778" />
              </TD>
              <TD>
                <span className="flex gap-3">
                  <button type="button" className="text-brand-600" onClick={() => onSelect(s.id)}>
                    查看明细
                  </button>
                  {active(s) && <CancelButton id={s.id} />}
                </span>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <Pagination page={page} pageSize={10} total={list.data?.total ?? 0} onPageChange={setPage} />
    </>
  );
}

type ScanFile = NonNullable<ModelFileScanRecord['files']>[number];
interface IdentityRow {
  key: string;
  label: string;
  paths: string[];
  id: ModelFileIdentification;
  known: ModelFileKnownModel | null;
  knownLabel: string;
}

/** 同一目录里结论相同的文件（如分片）合成一行。 */
function identityRows(files: ScanFile[]): IdentityRow[] {
  const rows = new Map<string, IdentityRow>();
  for (const f of files) {
    const id = f.meta.identification as ModelFileIdentification | undefined;
    if (!id) continue;
    const known = (f.meta.knownModel as ModelFileKnownModel | null | undefined) ?? null;
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
    const key = [dir, known?.repo, id.verdict, id.quantization, id.baseModel].join('\u0000');
    const row = rows.get(key);
    if (row) row.paths.push(f.path);
    else
      rows.set(key, {
        key,
        label: f.path,
        paths: [f.path],
        id,
        known,
        knownLabel: String(f.meta.knownModelLabel ?? ''),
      });
  }
  return [...rows.values()].map((r) => {
    const dir = r.label.includes('/') ? r.label.slice(0, r.label.lastIndexOf('/') + 1) : './';
    return r.paths.length > 1 ? { ...r, label: `${dir}（${r.paths.length} 个文件）` } : r;
  });
}

function ModelIdentity({ files }: { files: ScanFile[] }) {
  const rows = identityRows(files);
  if (!rows.length) return null;
  return (
    <section aria-label="模型识别" className="space-y-2">
      <h3 className="text-sm font-medium">模型识别</h3>
      <Table>
        <THead>
          <TR>
            <TH>文件</TH>
            <TH>已知模型</TH>
            <TH>类型</TH>
            <TH>量化</TH>
            <TH>基座</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((r) => (
            <TR key={r.key}>
              <TD className="font-mono text-xs" title={r.paths.join('\n')}>
                {r.label}
              </TD>
              <TD>
                {r.known ? (
                  <span className="flex flex-col">
                    <span>{r.knownLabel}</span>
                    <a
                      href={r.known.source}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-xs text-brand-600"
                    >
                      {r.known.repo}
                    </a>
                    {r.known.verifiedVia && (
                      <span className="text-xs text-muted-foreground">
                        哈希经 {r.known.verifiedVia} 核对
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="text-muted-foreground">{r.knownLabel || '—'}</span>
                )}
              </TD>
              <TD title={r.id.basis.join('；')}>{r.id.verdictLabel}</TD>
              <TD>{r.id.quantization ?? '—'}</TD>
              <TD className="font-mono text-xs">{r.id.baseModel ?? '—'}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </section>
  );
}

function ScriptRisks({ id, status }: { id: string; status: ModelFileScanRecord['status'] }) {
  const risks = useQuery({
    queryKey: ['model-files', 'script-risks', id, status],
    queryFn: () => modelFilesApi.scriptRisks(id),
    enabled: status === 'COMPLETED',
  });
  const groups = risks.data?.groups ?? [];
  if (!groups.length) return null;
  return (
    <section aria-label="脚本风险" className="space-y-3">
      <h3 className="text-sm font-medium">脚本风险</h3>
      {groups.map((g) => {
        const label = FORMAT_LABEL[g.format] ?? g.format;
        return (
          <div key={g.format} role="group" aria-label={label} className="space-y-1">
            <div className="text-sm">
              {label} <span className="tabular-nums text-muted-foreground">{g.total}</span>
              {g.total > g.items.length && (
                <span className="ml-2 text-xs text-muted-foreground">
                  仅列出前 {g.items.length} 条
                </span>
              )}
            </div>
            <Table>
              <THead>
                <TR>
                  <TH>文件</TH>
                  <TH>严重度</TH>
                  <TH>问题</TH>
                  <TH>证据</TH>
                </TR>
              </THead>
              <TBody>
                {g.items.map((f) => (
                  <TR key={f.id}>
                    <TD className="max-w-[200px] truncate font-mono text-xs" title={f.filePath}>
                      {f.filePath}
                    </TD>
                    <TD>
                      <span style={{ color: RISK_COLOR[f.severity] }}>
                        {severityLabel(f.severity)}
                      </span>
                    </TD>
                    <TD>{f.title}</TD>
                    <TD className="max-w-[420px] break-all text-xs">{f.evidence}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        );
      })}
    </section>
  );
}

export function ScanDetail({ id }: { id: string }) {
  const toast = useToast();
  const [severity, setSeverity] = useState('');
  const [page, setPage] = useState(1);
  const scan = useQuery({
    queryKey: ['model-files', 'scan', id],
    queryFn: () => modelFilesApi.get(id),
    refetchInterval: (q) => (q.state.data && active(q.state.data) ? 2000 : false),
  });
  const findings = useQuery({
    queryKey: ['model-files', 'findings', id, severity, page, scan.data?.status],
    queryFn: () =>
      modelFilesApi.findings(id, { severity: severity || undefined, page, pageSize: 20 }),
  });
  const exportBom = useMutation({
    mutationFn: () => modelFilesApi.exportAibom(id),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'AIBOM 导出失败'),
  });
  if (scan.isLoading) return <LoadingBlock label="正在加载扫描明细…" />;
  const s = scan.data as ModelFileScanRecord | undefined;
  if (!s) return <p className="text-sm text-muted-foreground">暂无数据</p>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        <span>方式：{SOURCE_LABEL[s.source]}</span>
        <span className="font-mono text-xs">{s.path}</span>
        <span>
          文件 <span className="tabular-nums">{s.fileCount}</span> 个，共{' '}
          {formatBytes(s.totalBytes)}，跳过非模型文件{' '}
          <span className="tabular-nums">{s.skippedCount}</span> 个
        </span>
        {s.hasAibom && (
          <button
            type="button"
            className="text-brand-600"
            disabled={exportBom.isPending}
            onClick={() => exportBom.mutate()}
          >
            导出 AIBOM（CycloneDX 1.6 JSON）
          </button>
        )}
      </div>
      {s.status === 'FAILED' && (
        <p className="text-sm text-severity-critical">扫描失败：{s.error}</p>
      )}
      {active(s) && (
        <p className="flex items-center gap-3 text-sm text-brand-600">
          <span>
            <Progress s={s} />
          </span>
          <CancelButton id={s.id} />
        </p>
      )}
      {s.status === 'CANCELLED' && (
        <p className="text-sm text-muted-foreground">扫描已取消，未生成结果。</p>
      )}
      {s.status === 'COMPLETED' && s.truncatedCount > 0 && (
        <p className="text-sm text-severity-high">
          部分结果：{s.truncatedReason}，另有 {s.truncatedCount}{' '}
          个模型文件未扫描。可由管理员在「管理目录」中调大扫描上限，或缩小扫描目录后重新扫描。
        </p>
      )}
      <ModelIdentity files={s.files ?? []} />
      <ScriptRisks id={s.id} status={s.status} />
      {(s.files ?? []).length > 0 && (
        <Table>
          <THead>
            <TR>
              <TH>文件</TH>
              <TH>格式</TH>
              <TH className="text-right">大小</TH>
              <TH>SHA-256</TH>
            </TR>
          </THead>
          <TBody>
            {(s.files ?? []).map((f) => (
              <TR key={f.path}>
                <TD className="font-mono text-xs">{f.path}</TD>
                <TD>{FORMAT_LABEL[f.format] ?? f.format}</TD>
                <TD className="text-right tabular-nums">{formatBytes(f.bytes)}</TD>
                <TD className="font-mono text-xs">{f.sha256.slice(0, 16)}…</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">严重度：</span>
        <Select
          aria-label="严重度筛选"
          value={severity}
          onChange={(e) => {
            setSeverity(e.target.value);
            setPage(1);
          }}
          className="w-32"
        >
          <option value="">全部</option>
          {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].map((v) => (
            <option key={v} value={v}>
              {severityLabel(v)}
            </option>
          ))}
        </Select>
      </div>
      {findings.isLoading ? (
        <LoadingBlock label="正在加载问题…" />
      ) : (findings.data?.items ?? []).length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">暂无数据</p>
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>文件</TH>
                <TH>格式</TH>
                <TH>严重度</TH>
                <TH>问题</TH>
                <TH>规则</TH>
                <TH>证据</TH>
              </TR>
            </THead>
            <TBody>
              {findings.data!.items.map((f) => (
                <TR key={f.id}>
                  <TD className="max-w-[200px] truncate font-mono text-xs" title={f.filePath}>
                    {f.filePath}
                  </TD>
                  <TD>{FORMAT_LABEL[f.format] ?? f.format}</TD>
                  <TD>
                    <span style={{ color: RISK_COLOR[f.severity] }}>
                      {severityLabel(f.severity)}
                    </span>
                  </TD>
                  <TD>{f.title}</TD>
                  <TD className="font-mono text-xs">{f.ruleId}</TD>
                  <TD className="max-w-[360px] break-all text-xs">{f.evidence}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination
            page={page}
            pageSize={20}
            total={findings.data?.total ?? 0}
            onPageChange={setPage}
          />
        </>
      )}
    </div>
  );
}
