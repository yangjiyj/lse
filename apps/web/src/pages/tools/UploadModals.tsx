import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  TOOL_ARCH_VALUES,
  TOOL_MANUAL_EXTS,
  TOOL_MANUAL_MAX_BYTES,
  TOOL_OS_VALUES,
  toolManualExt,
} from '@lse/shared';
import type { ApiError } from '@/lib/api';
import { toolsApi, type ToolManual } from '@/lib/tools';
import { formatBytes } from '@/components/model-files/format';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { TOOLS_QUERY_KEY, archLabel, osLabel } from './labels';

function ProgressLine({ loaded, total }: { loaded: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  return (
    <div className="sm:col-span-2" role="status" aria-label="上传进度">
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full bg-brand-500 transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-xs text-ink-3 font-num">
        {formatBytes(loaded)} / {formatBytes(total)}
      </p>
    </div>
  );
}

const tooLarge = (max: number) => `文件超过 ${formatBytes(max)} 的上限`;

/** 上传可取消：每次上传一个 AbortController；弹窗关掉（卸载）时也中止。 */
function useUploadAbort() {
  const ref = useRef<AbortController | null>(null);
  useEffect(() => () => ref.current?.abort(), []);
  return {
    next() {
      ref.current = new AbortController();
      return ref.current.signal;
    },
    abort() {
      ref.current?.abort();
    },
  };
}

/** 上传一个版本：文件、版本号、系统、架构、版本说明。maxBytes 是接口给的上限，超了直接提示。 */
export function VersionUploadModal({
  toolId,
  maxBytes,
  onClose,
}: {
  toolId: string;
  maxBytes?: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { success } = useToast();
  const uploadAbort = useUploadAbort();
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState('');
  const [os, setOs] = useState<string>('linux');
  const [arch, setArch] = useState<string>('amd64');
  const [releaseNotes, setReleaseNotes] = useState('');
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const upload = useMutation({
    mutationFn: () =>
      toolsApi.uploadVersion(
        toolId,
        file!,
        { version: version.trim(), os, arch, releaseNotes: releaseNotes.trim() },
        {
          onProgress: (loaded, total) => setProgress({ loaded, total }),
          signal: uploadAbort.next(),
        },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [TOOLS_QUERY_KEY] });
      success('版本已上传');
      onClose();
    },
    onError: (e) => {
      setProgress(null);
      if ((e as ApiError).code !== 'UPLOAD_ABORTED') setError((e as Error).message);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!file) return setError('请选择文件');
    if (maxBytes && file.size > maxBytes) return setError(tooLarge(maxBytes));
    if (!version.trim()) return setError('请填写版本号');
    upload.mutate();
  };
  // 上传中点「取消」：中止上传（服务端会删掉半截文件）并关闭。
  const cancel = () => {
    uploadAbort.abort();
    onClose();
  };
  return (
    <Modal
      open
      onClose={upload.isPending ? () => undefined : onClose}
      title="上传版本"
      footer={
        <>
          <Button variant="outline" onClick={cancel}>
            取消
          </Button>
          <Button type="submit" form="tool-version-form" disabled={upload.isPending}>
            上传
          </Button>
        </>
      }
    >
      <form id="tool-version-form" className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
        <Field label="文件" htmlFor="tool-version-file" required className="sm:col-span-2">
          <Input
            id="tool-version-file"
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </Field>
        <Field label="版本号" htmlFor="tool-version-version" required className="sm:col-span-2">
          <Input
            id="tool-version-version"
            value={version}
            placeholder="如 1.2.0"
            onChange={(e) => setVersion(e.target.value)}
          />
        </Field>
        <Field label="操作系统" htmlFor="tool-version-os">
          <Select id="tool-version-os" value={os} onChange={(e) => setOs(e.target.value)}>
            {TOOL_OS_VALUES.map((v) => (
              <option key={v} value={v}>
                {osLabel(v)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="硬件架构" htmlFor="tool-version-arch">
          <Select id="tool-version-arch" value={arch} onChange={(e) => setArch(e.target.value)}>
            {TOOL_ARCH_VALUES.map((v) => (
              <option key={v} value={v}>
                {archLabel(v)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="版本说明" htmlFor="tool-version-notes" className="sm:col-span-2">
          <Textarea
            id="tool-version-notes"
            rows={3}
            maxLength={500}
            value={releaseNotes}
            onChange={(e) => setReleaseNotes(e.target.value)}
          />
        </Field>
        {progress && <ProgressLine {...progress} />}
        {error && (
          <p className="text-sm text-destructive sm:col-span-2" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

const MANUAL_ACCEPT = TOOL_MANUAL_EXTS.map((e) => `.${e}`).join(',');

/** 上传或替换操作手册（pdf、docx、md、txt）。替换时不填标题就保留原标题。 */
export function ManualUploadModal({
  toolId,
  manual,
  onClose,
}: {
  toolId: string;
  manual?: ToolManual;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { success } = useToast();
  const uploadAbort = useUploadAbort();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState(manual?.title ?? '');
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const upload = useMutation({
    mutationFn: () => {
      const opts = {
        onProgress: (loaded: number, total: number) => setProgress({ loaded, total }),
        signal: uploadAbort.next(),
      };
      return manual
        ? toolsApi.replaceManual(toolId, manual.id, file!, title.trim(), opts)
        : toolsApi.uploadManual(toolId, file!, title.trim(), opts);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [TOOLS_QUERY_KEY] });
      success(manual ? '手册已替换' : '手册已上传');
      onClose();
    },
    onError: (e) => {
      setProgress(null);
      if ((e as ApiError).code !== 'UPLOAD_ABORTED') setError((e as Error).message);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!file) return setError('请选择文件');
    if (!toolManualExt(file.name))
      return setError(`手册只支持 ${TOOL_MANUAL_EXTS.join('、')} 格式`);
    if (file.size > TOOL_MANUAL_MAX_BYTES) return setError(tooLarge(TOOL_MANUAL_MAX_BYTES));
    upload.mutate();
  };
  const cancel = () => {
    uploadAbort.abort();
    onClose();
  };
  return (
    <Modal
      open
      onClose={upload.isPending ? () => undefined : onClose}
      title={manual ? '替换手册' : '上传手册'}
      footer={
        <>
          <Button variant="outline" onClick={cancel}>
            取消
          </Button>
          <Button type="submit" form="tool-manual-form" disabled={upload.isPending}>
            {manual ? '替换' : '上传'}
          </Button>
        </>
      }
    >
      <form id="tool-manual-form" className="grid gap-4" onSubmit={submit}>
        <Field
          label="文件"
          htmlFor="tool-manual-file"
          required
          hint={`${TOOL_MANUAL_EXTS.join('、')}，不超过 100 MiB`}
        >
          <Input
            id="tool-manual-file"
            type="file"
            accept={MANUAL_ACCEPT}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </Field>
        <Field label="标题" htmlFor="tool-manual-title">
          <Input
            id="tool-manual-title"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        {progress && <ProgressLine {...progress} />}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
