import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileJson2, Upload } from 'lucide-react';
import { api, ApiError, type ModelTarget } from '@/lib/api';
import { Modal } from '@/components/ui/modal';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';

const MAX_FILE_BYTES = 18 * 1024 * 1024;

interface AdrTraceImportModalProps {
  initialTargetId?: string;
  open: boolean;
  onClose: () => void;
}

function importableTarget(target: ModelTarget): boolean {
  return target.isActive && target.targetType !== 'JUDGE';
}

function targetLabel(target: ModelTarget): string {
  const kind =
    target.targetType === 'AGENT_API'
      ? '智能体 API'
      : target.targetType === 'PUBLIC_AGENT'
        ? '公开智能体'
        : target.targetType === 'MCP_OPENAPI'
          ? 'MCP / OpenAPI'
          : target.targetType === 'GATEWAY_LOG'
            ? '网关对象'
            : '模型对象';
  return `${target.name}（${kind}）`;
}

function entryCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'object' && value !== null && 'entries' in value) {
    const entries = (value as { entries?: unknown }).entries;
    if (Array.isArray(entries)) return entries.length;
  }
  return 1;
}

function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'));
    reader.readAsText(file);
  });
}

export function AdrTraceImportModal({ open, onClose, initialTargetId }: AdrTraceImportModalProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [modelTargetId, setModelTargetId] = useState('');
  useEffect(() => {
    if (open && initialTargetId) setModelTargetId(initialTargetId);
  }, [open, initialTargetId]);
  const [name, setName] = useState('');
  const [payload, setPayload] = useState<unknown>();
  const [fileName, setFileName] = useState('');
  const [fileError, setFileError] = useState('');

  const targetsQuery = useQuery({
    queryKey: ['model-targets', 'adr-trace-import'],
    queryFn: () => api.modelTargets.list({ page: 1, pageSize: 200 }),
    enabled: open,
  });
  const targets = useMemo(
    () => (targetsQuery.data?.items ?? []).filter(importableTarget),
    [targetsQuery.data],
  );

  const reset = () => {
    setModelTargetId('');
    setName('');
    setPayload(undefined);
    setFileName('');
    setFileError('');
  };

  useEffect(() => {
    if (!open) reset();
  }, [open]);

  const importMutation = useMutation({
    mutationFn: () =>
      api.agentEvals.importAdrTrace({
        modelTargetId,
        name: name.trim() || undefined,
        payload,
      }),
    onSuccess: (result) => {
      toast.success(
        `轨迹分析完成：${result.summary.entryCount} 个会话，发现 ${result.summary.findingCount} 项风险。`,
      );
      qc.invalidateQueries({ queryKey: ['eval-tasks'] });
      onClose();
      navigate(`/eval-tasks/${result.taskId}`);
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : '轨迹导入失败，请检查文件格式'),
  });

  async function chooseFile(file: File | undefined) {
    setFileError('');
    setPayload(undefined);
    setFileName('');
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setFileError('文件不能超过 18 MB；请按会话分批导出后再上传。');
      return;
    }
    try {
      const parsed = JSON.parse(await readFileText(file)) as unknown;
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('JSON 顶层必须是对象或数组');
      }
      setPayload(parsed);
      setFileName(file.name);
    } catch (error) {
      setFileError(error instanceof Error ? `无法读取 JSON：${error.message}` : '无法读取 JSON');
    }
  }

  const canImport = modelTargetId.length > 0 && payload !== undefined && !importMutation.isPending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="导入智能体运行轨迹"
      description="无端模式：上传 ADR Sensor 兼容 JSON，由 LSE 分析后直接生成风险任务和专项报告。"
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!canImport} onClick={() => importMutation.mutate()}>
            {importMutation.isPending ? (
              <Spinner className="h-4 w-4" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            导入并分析
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-brand-100 bg-brand-50/70 px-4 py-3 text-[13px] leading-6 text-ink-2">
          LSE 不要求在客户机器安装组件。客户可以使用 ADR Sensor，也可以由现有系统导出同结构
          JSON。平台只保存匿名会话指纹、统计量和脱敏风险证据，不保存完整对话、主机名、用户名或项目路径。
        </div>

        <Field label="轨迹归属对象" required htmlFor="adr-trace-target">
          <Select
            id="adr-trace-target"
            value={modelTargetId}
            onChange={(event) => setModelTargetId(event.target.value)}
          >
            <option value="">请选择…</option>
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {targetLabel(target)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="任务名称（可选）" htmlFor="adr-trace-name">
          <Input
            id="adr-trace-name"
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            placeholder="留空则按对象名称和时间自动生成"
          />
        </Field>

        <Field label="ADR-compatible JSON" required htmlFor="adr-trace-file">
          <label
            htmlFor="adr-trace-file"
            className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 transition-colors hover:border-primary hover:bg-primary/5"
          >
            <FileJson2 className="h-7 w-7 shrink-0 text-primary" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-slate-900">
                {fileName || '选择 JSON 文件'}
              </span>
              <span className="block text-xs leading-5 text-slate-500">
                支持单会话对象、会话数组或 Sensor entries 包装格式，最大 18 MB
              </span>
            </span>
          </label>
          <input
            id="adr-trace-file"
            className="sr-only"
            type="file"
            accept="application/json,.json"
            onChange={(event) => void chooseFile(event.target.files?.[0])}
          />
        </Field>

        {payload !== undefined && (
          <div className="rounded-xl border border-severity-pass/25 bg-severity-pass-bg px-3 py-2 text-sm text-severity-pass">
            文件读取成功，检测到约 {entryCount(payload)} 个会话；服务端将继续执行严格格式校验。
          </div>
        )}
        {fileError && (
          <div className="rounded-xl border border-severity-critical/25 bg-severity-critical-bg px-3 py-2 text-sm text-severity-critical">
            {fileError}
          </div>
        )}
        {importMutation.error && (
          <div className="rounded-xl border border-severity-critical/25 bg-severity-critical-bg px-3 py-2 text-sm text-severity-critical">
            {importMutation.error instanceof ApiError
              ? importMutation.error.message
              : '轨迹导入失败，请稍后重试'}
          </div>
        )}
      </div>
    </Modal>
  );
}
