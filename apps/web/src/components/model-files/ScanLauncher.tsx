import { useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderCog } from 'lucide-react';
import { api, ApiError, modelFilesApi, type ModelFileAibomFields } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { ModelFileLibrary } from './ModelFileLibrary';
import { DirectoryBrowser } from './DirectoryBrowser';
import { ManageRootsDialog } from './ManageRootsDialog';
import { estimateReadDuration, formatBytes, hfRepoFromPath, UNIT } from './format';

function errorText(e: unknown, fallback: string) {
  return e instanceof ApiError ? e.message : fallback;
}

type Mode = 'upload' | 'directory';

/** 发起扫描：上传单个文件，或在服务器目录里逐级浏览后扫描；可选关联评估对象并补充清单（AIBOM）字段。 */
export function ScanLauncher({ onDone }: { onDone: (id: string) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('platform_setting:update');
  const [mode, setMode] = useState<Mode>('upload');
  const [manageOpen, setManageOpen] = useState(false);
  const [targetId, setTargetId] = useState('');
  const [license, setLicense] = useState('');
  const [source, setSource] = useState('');
  const [parameterInfo, setParameterInfo] = useState('');
  const [datasets, setDatasets] = useState('');
  const [sbomFile, setSbomFile] = useState<File | null>(null);

  const config = useQuery({
    queryKey: ['model-files', 'config'],
    queryFn: () => modelFilesApi.config(),
  });
  const targets = useQuery({
    queryKey: ['model-targets', 'aibom-select'],
    queryFn: () => api.modelTargets.list({ pageSize: 100 }),
  });
  const cfg = config.data;
  const hostDir = cfg?.hostDir ?? null;
  const allRoots = cfg?.rootDetails ?? [];
  // 只有当前能读的目录才放进浏览；不可用的在「管理目录」里看原因
  const roots = allRoots.filter((r) => r.readable);

  async function scanFields(autoSource?: string | null): Promise<ModelFileAibomFields> {
    const extra: ModelFileAibomFields = {
      targetId: targetId || null,
      license: license || undefined,
      source: source || autoSource || undefined,
      parameterInfo: parameterInfo || undefined,
      datasetRefs: datasets
        .split(/[\n,，]/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
    if (sbomFile)
      extra.dependencySbom = {
        contentType: sbomFile.name.endsWith('.spdx') ? 'text/spdx' : 'application/json',
        content: await sbomFile.text(),
      };
    return extra;
  }

  const run = useMutation({
    mutationFn: async (dirPath: string) => {
      const extra = await scanFields(hfRepoFromPath(dirPath));
      return modelFilesApi.scanDirectory({ path: dirPath, ...extra });
    },
    onSuccess: (r) => {
      toast.success('扫描任务已提交，正在后台执行');
      void qc.invalidateQueries({ queryKey: ['model-files', 'scans'] });
      onDone(r.id);
    },
    onError: (e) => {
      toast.error(errorText(e, '扫描失败'));
      void qc.invalidateQueries({ queryKey: ['model-files', 'scans'] });
    },
  });

  const manage = canManage ? (
    <Button variant="outline" size="sm" onClick={() => setManageOpen(true)}>
      <FolderCog className="h-4 w-4" />
      管理目录
    </Button>
  ) : (
    <p data-testid="readonly-roots" className="text-xs text-muted-foreground">
      如需增加目录请联系管理员
    </p>
  );

  const extras = (
    <>
      <Field
        label="关联评估对象（可选）"
        htmlFor="mf-target"
        hint="关联后该对象详情页展示最近一次扫描结论与 AIBOM，AIBOM 模型名称自动取评估对象名称。"
      >
        <Select id="mf-target" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
          <option value="">不关联</option>
          {(targets.data?.items ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </Field>
      <details className="rounded-lg border border-border">
        <summary className="cursor-pointer px-3 py-2 text-sm">AIBOM 补充信息（可选）</summary>
        <div className="grid grid-cols-1 gap-4 p-3 sm:grid-cols-2">
          <Field label="许可（可选）" htmlFor="mf-license">
            <Input
              id="mf-license"
              value={license}
              maxLength={500}
              placeholder="如 Apache-2.0"
              onChange={(e) => setLicense(e.target.value)}
            />
          </Field>
          <Field label="来源地址（可选）" htmlFor="mf-source">
            <Input
              id="mf-source"
              value={source}
              maxLength={1000}
              onChange={(e) => setSource(e.target.value)}
            />
          </Field>
          <Field
            label="参数信息（可选）"
            htmlFor="mf-param"
            hint="解析得到的参数量会自动写入，此处可补充说明。"
          >
            <Input
              id="mf-param"
              value={parameterInfo}
              maxLength={1000}
              onChange={(e) => setParameterInfo(e.target.value)}
            />
          </Field>
          <Field label="数据集引用（可选）" htmlFor="mf-datasets" hint="多个用逗号或换行分隔。">
            <Input
              id="mf-datasets"
              value={datasets}
              onChange={(e) => setDatasets(e.target.value)}
            />
          </Field>
          <Field
            label="依赖 SBOM（可选）"
            htmlFor="mf-sbom"
            hint="CycloneDX / SPDX JSON 或 SPDX tag-value，≤2MiB，合并进 AIBOM 组件与依赖。"
          >
            <Input
              id="mf-sbom"
              type="file"
              accept=".json,.spdx"
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setSbomFile(e.target.files?.[0] ?? null)
              }
            />
          </Field>
        </div>
        <p className="px-3 pb-3 text-xs text-muted-foreground">
          文件指纹、格式、参数量/张量数、GGUF 架构等由扫描自动写入 AIBOM；不填也可生成。
        </p>
      </details>
    </>
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-6 border-b border-border text-sm" role="tablist">
        {(['upload', 'directory'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={`-mb-px border-b-2 pb-2 ${mode === m ? 'border-brand-600 text-brand-600' : 'border-transparent text-muted-foreground'}`}
          >
            {m === 'upload' ? '模型文件库' : '目录扫描'}
          </button>
        ))}
      </div>

      {mode === 'upload' ? (
        <>
          <ModelFileLibrary
            onDone={onDone}
            fields={() => scanFields()}
            uploadMaxBytes={cfg?.uploadMaxBytes ?? 0}
          />
          {extras}
        </>
      ) : !cfg ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" />
          正在读取目录配置…
        </div>
      ) : roots.length === 0 ? (
        <div
          data-testid="no-roots"
          className="space-y-2 rounded-lg border border-border bg-[#F8FAFD] p-4 text-sm text-muted-foreground"
        >
          <p className="font-medium text-foreground">暂无可扫描的目录</p>
          {allRoots.length > 0 ? (
            <ul className="list-disc pl-5">
              {allRoots.map((r) => (
                <li key={r.path}>
                  <span className="font-mono">{r.hostPath ?? r.path}</span>：{r.problem ?? '不可用'}
                </li>
              ))}
            </ul>
          ) : (
            <p>
              请把模型文件放到服务器上的{' '}
              {hostDir ? <span className="font-mono text-foreground">{hostDir}</span> : '模型目录'}{' '}
              目录（或其子目录）下，刷新页面即可看到。
            </p>
          )}
          <p>也可由管理员在「管理目录」中添加其他已挂载的目录。</p>
          <div>{manage}</div>
        </div>
      ) : (
        <>
          {extras}
          <DirectoryBrowser
            roots={roots}
            manage={manage}
            scanning={run.isPending}
            onScan={(path) => run.mutate(path)}
          />
          <p data-testid="scan-limits-note" className="text-xs text-muted-foreground">
            单次扫描最多 {cfg.maxFiles} 个模型文件、共 {formatBytes(cfg.totalMaxBytes)}
            ；扫描会完整读取每个模型文件，每 100 GiB 约需 {estimateReadDuration(100 * UNIT.GiB)}
            （取决于磁盘速度）；超出时扫描前面的文件并标记为部分结果。指向可扫描范围之外的符号链接会被跳过。
          </p>
        </>
      )}

      {canManage && cfg && (
        <ManageRootsDialog open={manageOpen} onClose={() => setManageOpen(false)} config={cfg} />
      )}
    </div>
  );
}
