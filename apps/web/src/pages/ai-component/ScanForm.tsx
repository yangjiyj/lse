import { useState, type ChangeEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  aiComponentsApi,
  ApiError,
  type AiComponentAssetType,
  type AiComponentConfig,
} from '@/lib/api';
import { buildTar } from '@/lib/tar-writer';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/page-kit/SectionCard';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { formatBytes } from './labels';
import {
  SourcePicker,
  UploadKindPicker,
  URL_NOT_ALLOWED_ADVICE,
  defaultSource,
  endpointHint,
  type Source,
  type UploadKind,
} from './SourcePicker';

type Mode = UploadKind | 'endpoint';
const ARCHIVE_ACCEPT = '.zip,.tar,.tgz,.tar.gz';

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** 目录选择时浏览器提供的相对路径；部分环境为 undefined */
function relPath(f: File): string {
  return (f as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
}

function readBytes(f: File): Promise<Uint8Array> {
  if (typeof f.arrayBuffer === 'function') return f.arrayBuffer().then((b) => new Uint8Array(b));
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error ?? new Error(`读取文件失败：${f.name}`));
    r.readAsArrayBuffer(f);
  });
}

export function ScanForm({
  canScan,
  onCreated,
}: {
  canScan: boolean;
  onCreated: (id: string) => void;
}) {
  const toast = useToast();
  const cfg = useQuery({
    queryKey: ['ai-components', 'config'],
    queryFn: () => aiComponentsApi.config(),
  });
  const [assetName, setAssetName] = useState('');
  const [assetType, setAssetType] = useState<AiComponentAssetType>('MCP');
  const [source, setSource] = useState<Source>(defaultSource('MCP'));
  const [uploadKind, setUploadKind] = useState<UploadKind>('archive');
  const [urlBlocked, setUrlBlocked] = useState<string | null>(null);
  const mode: Mode = source === 'endpoint' ? 'endpoint' : uploadKind;
  const [assetVersion, setAssetVersion] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [url, setUrl] = useState('');
  const [headerText, setHeaderText] = useState('');
  const maxBytes = cfg.data?.uploadMaxBytes ?? 0;

  const pickedBytes = files.reduce((n, f) => n + f.size, 0);
  const tooLarge = maxBytes > 0 && pickedBytes > maxBytes;

  const run = useMutation({
    mutationFn: async () => {
      const base = {
        assetName: assetName.trim(),
        assetType,
        assetVersion: assetVersion.trim() || undefined,
      };
      if (mode === 'endpoint') {
        const headers = parseHeaders(headerText);
        return aiComponentsApi.scanEndpoint({
          ...base,
          url: url.trim(),
          headers: Object.keys(headers).length ? headers : undefined,
        });
      }
      if (mode === 'archive') {
        const f = files[0]!;
        return aiComponentsApi.upload(
          { ...base, fileName: f.name, mode: 'ARCHIVE', sourceLabel: f.name },
          f,
        );
      }
      if (files.length === 1 && !relPath(files[0]!)) {
        const f = files[0]!;
        return aiComponentsApi.upload(
          { ...base, fileName: f.name, mode: 'UPLOAD', sourceLabel: f.name },
          f,
        );
      }
      const entries = await Promise.all(
        files.map(async (f) => ({ path: relPath(f) || f.name, data: await readBytes(f) })),
      );
      const root = relPath(files[0]!).split('/')[0] || 'files';
      return aiComponentsApi.upload(
        {
          ...base,
          fileName: `${root}.tar`,
          mode: 'ARCHIVE',
          sourceLabel: `${root}（${files.length} 个文件）`,
        },
        buildTar(entries),
      );
    },
    onMutate: () => setUrlBlocked(null),
    onSuccess: (r) => {
      toast.success('扫描完成');
      setFiles([]);
      onCreated(r.id);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'MCP_URL_NOT_ALLOWED') {
        setUrlBlocked(e.message);
        toast.error('MCP 服务地址被出站策略拒绝');
        return;
      }
      toast.error(e instanceof ApiError ? e.message : e instanceof Error ? e.message : '扫描失败');
    },
  });

  const changeAssetType = (t: AiComponentAssetType) => {
    setAssetType(t);
    setSource(defaultSource(t));
    setFiles([]);
    setUrlBlocked(null);
  };
  const changeSource = (s: Source) => {
    setSource(s);
    setFiles([]);
    setUrlBlocked(null);
  };
  const changeUploadKind = (k: UploadKind) => {
    setUploadKind(k);
    setFiles([]);
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    setFiles(Array.from(e.target.files ?? []));
    e.target.value = '';
  };

  const ready =
    canScan &&
    !!assetName.trim() &&
    !run.isPending &&
    (mode === 'endpoint'
      ? !!url.trim() && !!cfg.data?.mcpFetch.available
      : files.length > 0 && !tooLarge);

  return (
    <SectionCard
      title="发起扫描"
      description="填写资产信息，选择检测方式后开始。"
      bodyClassName="space-y-4"
    >
      <Field
        label="资产名称"
        htmlFor="aic-name"
        required
        hint="同名同类型的资产会归为一组，用于版本对比与工具描述基线。"
      >
        <Input
          id="aic-name"
          value={assetName}
          maxLength={200}
          onChange={(e) => setAssetName(e.target.value)}
          placeholder="例如 filesystem-mcp"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="资产类型" htmlFor="aic-type">
          <Select
            id="aic-type"
            value={assetType}
            onChange={(e) => changeAssetType(e.target.value as AiComponentAssetType)}
          >
            <option value="MCP">MCP Server</option>
            <option value="SKILL">Skill</option>
            <option value="PLUGIN">插件</option>
          </Select>
        </Field>
        <Field label="版本（选填）" htmlFor="aic-ver">
          <Input
            id="aic-ver"
            value={assetVersion}
            maxLength={100}
            onChange={(e) => setAssetVersion(e.target.value)}
            placeholder="1.2.0"
          />
        </Field>
      </div>
      <SourcePicker assetType={assetType} value={source} onChange={changeSource} />
      {mode === 'endpoint' ? (
        <EndpointFields
          cfg={cfg.data}
          url={url}
          setUrl={(v) => {
            setUrl(v);
            setUrlBlocked(null);
          }}
          headerText={headerText}
          setHeaderText={setHeaderText}
          blocked={urlBlocked}
        />
      ) : (
        <>
          <UploadKindPicker value={uploadKind} onChange={changeUploadKind} />
          <UploadFields
            mode={mode}
            files={files}
            onPick={onPick}
            maxBytes={maxBytes}
            pickedBytes={pickedBytes}
            tooLarge={tooLarge}
          />
        </>
      )}
      <Button type="button" onClick={() => run.mutate()} disabled={!ready} className="w-full">
        {run.isPending ? '扫描中…' : '开始扫描'}
      </Button>
      {!canScan ? (
        <p className="text-xs text-muted-foreground">
          当前账号没有“引擎扫描”权限，请联系管理员在 用户与权限 中授予。
        </p>
      ) : null}
    </SectionCard>
  );
}

function UploadFields(props: {
  mode: Mode;
  files: File[];
  onPick: (e: ChangeEvent<HTMLInputElement>) => void;
  maxBytes: number;
  pickedBytes: number;
  tooLarge: boolean;
}) {
  const { mode, files, onPick, maxBytes, pickedBytes, tooLarge } = props;
  return (
    <>
      {mode === 'archive' ? (
        <Field
          label="压缩包"
          htmlFor="aic-archive"
          hint={
            maxBytes
              ? `单次上传不超过 ${formatBytes(maxBytes)}；压缩包内的符号链接、路径穿越条目会被拒绝。`
              : undefined
          }
        >
          <Input id="aic-archive" type="file" accept={ARCHIVE_ACCEPT} onChange={onPick} />
        </Field>
      ) : (
        <div className="space-y-2">
          <Field
            label="选择目录"
            htmlFor="aic-dir"
            hint="浏览器会把目录内文件打包为 tar 后上传；node_modules、.git 等目录在服务端跳过。"
          >
            <Input
              id="aic-dir"
              type="file"
              multiple
              onChange={onPick}
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            />
          </Field>
          <Field label="或选择多个文件" htmlFor="aic-files">
            <Input id="aic-files" type="file" multiple onChange={onPick} />
          </Field>
        </div>
      )}
      <div className="rounded-lg border border-line bg-canvas px-3 py-2 text-xs text-ink-3">
        {files.length ? (
          <>
            已选 {files.length} 个文件，共 {formatBytes(pickedBytes)}
            {tooLarge ? (
              <span className="ml-1 text-severity-critical">
                超过上传上限 {formatBytes(maxBytes)}，请精简后重试
              </span>
            ) : null}
          </>
        ) : (
          '尚未选择文件。建议同时包含说明文档（SKILL.md / README）、工具定义与实现源码，便于核对声明与实现是否一致。'
        )}
      </div>
    </>
  );
}

function EndpointFields(props: {
  cfg?: AiComponentConfig;
  url: string;
  setUrl: (v: string) => void;
  headerText: string;
  setHeaderText: (v: string) => void;
  blocked: string | null;
}) {
  const { cfg, url, setUrl, headerText, setHeaderText, blocked } = props;
  if (cfg && !cfg.mcpFetch.available) {
    return (
      <p className="rounded-lg border border-line bg-canvas px-3 py-2 text-xs text-ink-3">
        {cfg.mcpFetch.reason ?? 'MCP 在线拉取暂不可用'}。可改为上传该 MCP 的源码或 tools/list 导出的
        JSON。
      </p>
    );
  }
  return (
    <>
      <Field
        label="MCP 服务地址"
        htmlFor="aic-url"
        required
        hint={endpointHint(cfg?.mcpFetch.egress)}
      >
        <Input
          id="aic-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://mcp.example.com/mcp"
        />
      </Field>
      {blocked ? (
        <div
          role="alert"
          className="rounded-lg border border-[#fbaca3] bg-severity-critical-bg px-3 py-2 text-xs leading-5 text-severity-critical"
        >
          <p>地址被出站策略拒绝：{blocked}</p>
          <p className="mt-1">{URL_NOT_ALLOWED_ADVICE}</p>
        </div>
      ) : null}
      <Field
        label="鉴权请求头（选填）"
        htmlFor="aic-headers"
        hint="每行一个，如 Authorization: Bearer xxx。仅用于本次拉取，不保存、不写日志。"
      >
        <Textarea
          id="aic-headers"
          rows={2}
          value={headerText}
          onChange={(e) => setHeaderText(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      {cfg ? <p className="text-xs text-muted-foreground">{cfg.stdioNote}</p> : null}
    </>
  );
}
