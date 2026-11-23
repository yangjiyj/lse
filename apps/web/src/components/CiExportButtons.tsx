import { useState } from 'react';
import { api, type CiExportFormat } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';

const FORMATS: Array<{ format: CiExportFormat; label: string; hint: string }> = [
  { format: 'junit', label: 'JUnit', hint: 'JUnit XML：流水线测试报告页可直接展示' },
  { format: 'sarif', label: 'SARIF', hint: 'SARIF 2.1.0：可上传到代码扫描类页面' },
  { format: 'json', label: 'JSON', hint: '任务摘要 + 门禁结果 + 发现列表' },
];

/** 导出 CI 结果（JUnit / SARIF / JSON）。导出不含模型完整回答，判定摘要已脱敏并截断。 */
export function CiExportButtons({
  taskId,
  size = 'sm',
  disabled,
}: {
  taskId: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
}) {
  const { error: toastError } = useToast();
  const [busy, setBusy] = useState<CiExportFormat | null>(null);
  async function run(format: CiExportFormat) {
    setBusy(format);
    try {
      await api.evalTasks.exportCi(taskId, format);
    } catch (e) {
      toastError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-testid="ci-export-buttons">
      <span className="text-xs text-ink-3">导出</span>
      {FORMATS.map((f) => (
        <Button
          key={f.format}
          type="button"
          variant="outline"
          size={size}
          title={`${f.hint}。不含模型完整回答，摘要已脱敏并截断。`}
          disabled={disabled || busy !== null}
          onClick={() => void run(f.format)}
        >
          {busy === f.format ? '导出中…' : f.label}
        </Button>
      ))}
    </span>
  );
}
