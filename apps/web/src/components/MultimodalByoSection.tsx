import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  api,
  ApiError,
  type ByoIssue,
  type ByoUploadResult,
  type ByoValidationDetails,
} from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

export const BYO_COMPLIANCE_NOTICE =
  '图片须由您自行确认合法合规来源，平台不提供也不保存与本次评估无关的图片；评估完成后可一键删除图片。';

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function IssueList({ issues, tone }: { issues: ByoIssue[]; tone: 'error' | 'warn' }) {
  const shown = issues.slice(0, 100);
  return (
    <ul
      className={`max-h-48 space-y-1 overflow-y-auto text-xs leading-5 ${tone === 'error' ? 'text-severity-critical' : 'text-severity-high'}`}
    >
      {shown.map((i, idx) => (
        <li key={idx}>
          {i.line > 0 ? `第 ${i.line} 行：` : '整体：'}
          {i.message}
        </li>
      ))}
      {issues.length > shown.length && <li>… 另有 {issues.length - shown.length} 项未显示</li>}
    </ul>
  );
}

interface Props {
  uploaded: ByoUploadResult | null;
  onUploaded: (result: ByoUploadResult | null) => void;
}

/** 多模态弹窗「客户自带图片集」：格式说明、模板下载、上传与校验报告、合规提示、一键删除。 */
export function MultimodalByoSection({ uploaded, onUploaded }: Props) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [failure, setFailure] = useState<{
    message: string;
    details: ByoValidationDetails | null;
  } | null>(null);
  const [deleted, setDeleted] = useState(false);

  const upload = useMutation({
    mutationFn: (f: File) => api.evalTasks.uploadByoImageSet(f, f.name.replace(/\.zip$/i, '')),
    onSuccess: (r) => {
      setFailure(null);
      setDeleted(false);
      onUploaded(r);
    },
    onError: (err) => {
      onUploaded(null);
      const details =
        err instanceof ApiError &&
        err.issues &&
        typeof err.issues === 'object' &&
        Array.isArray((err.issues as ByoValidationDetails).issues)
          ? (err.issues as ByoValidationDetails)
          : null;
      setFailure({ message: err instanceof ApiError ? err.message : '上传失败，请重试', details });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.evalTasks.deleteByoImageSetImages(id),
    onSuccess: () => {
      setDeleted(true);
      onUploaded(null);
      toast.success('已删除本次上传的全部图片');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '删除图片失败'),
  });
  const template = useMutation({
    mutationFn: () => api.evalTasks.downloadByoManifestTemplate(),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '模板下载失败'),
  });

  return (
    <div className="space-y-3" aria-label="客户自带图片集">
      <div className="rounded-md border border-severity-high/40 bg-severity-high-bg p-3 text-xs leading-5 text-[#7a4300]">
        <span className="font-medium">合规提示：</span>
        {BYO_COMPLIANCE_NOTICE}
      </div>
      <div className="rounded-md bg-slate-50 p-3 text-xs leading-5 text-slate-600">
        <p className="font-medium text-slate-700">上传格式</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          <li>
            一个 zip 压缩包，内含若干 png / jpg / webp 图片，以及根目录下的 manifest.csv（UTF-8）。
          </li>
          <li>
            manifest.csv
            列：image（图片文件名，必填）、prompt（随图发送的提问，必填）、category（类别，可选）、expected（应拒绝
            / 应谨慎 / 可正常回答，可选，缺省为应拒绝）、note（备注，可选）。
          </li>
          <li>
            限制：zip 不超过 100MB，单张图片不超过 8MB，最多 500
            条；按文件头校验格式，不信任扩展名。
          </li>
          <li>“可正常回答”的题用于检测过度拒答：模型无故拒答会被判为风险。</li>
        </ul>
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          disabled={template.isPending}
          onClick={() => template.mutate()}
        >
          下载 manifest 模板
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip"
          aria-label="选择图片集 zip"
          className="text-sm"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setFailure(null);
            setDeleted(false);
            onUploaded(null);
          }}
        />
        <Button
          size="sm"
          disabled={!file || upload.isPending}
          onClick={() => file && upload.mutate(file)}
        >
          {upload.isPending && <Spinner className="h-4 w-4" />}
          上传并校验
        </Button>
      </div>

      {failure && (
        <div role="alert" className="space-y-2 rounded-md border border-severity-critical/40 p-3">
          <p className="text-sm font-medium text-severity-critical">{failure.message}</p>
          {failure.details && <IssueList issues={failure.details.issues} tone="error" />}
          {failure.details && failure.details.warnings.length > 0 && (
            <IssueList issues={failure.details.warnings} tone="warn" />
          )}
        </div>
      )}
      {uploaded && (
        <div className="space-y-2 rounded-md border border-severity-pass/40 p-3">
          <p className="text-sm font-medium text-severity-pass">
            校验通过：共 {uploaded.questionCount} 道题、{uploaded.imageCount} 张图片（
            {formatSize(uploaded.stats.unpackedBytes)}）
          </p>
          {uploaded.warnings.length > 0 && <IssueList issues={uploaded.warnings} tone="warn" />}
          <Button
            variant="outline"
            size="sm"
            disabled={remove.isPending}
            onClick={() => remove.mutate(uploaded.id)}
          >
            删除已上传的图片
          </Button>
        </div>
      )}
      {deleted && !uploaded && (
        <p className="text-xs text-slate-500">已删除上传的图片，如需评估请重新上传。</p>
      )}
    </div>
  );
}
