import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

export interface ExportFormatOption<F extends string> {
  format: F;
  label: string;
}

/** 「导出 [格式]…」按钮组：按所选格式下载，失败时提示原因。 */
export function ExportButtons<F extends string>({
  name,
  formats,
  onExport,
  disabled,
  className,
}: {
  /** 按钮组的无障碍名称，如「导出执行日志」。 */
  name: string;
  formats: Array<ExportFormatOption<F>>;
  onExport: (format: F) => Promise<unknown>;
  disabled?: boolean;
  className?: string;
}) {
  const { error: toastError } = useToast();
  const [busy, setBusy] = useState<F | null>(null);
  async function run(format: F) {
    setBusy(format);
    try {
      await onExport(format);
    } catch (e) {
      toastError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <span
      role="group"
      aria-label={name}
      className={cn('inline-flex flex-wrap items-center gap-1.5', className)}
    >
      <span className="text-xs text-ink-3">导出</span>
      {formats.map((f) => (
        <Button
          key={f.format}
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || busy !== null}
          onClick={() => void run(f.format)}
        >
          {f.label}
        </Button>
      ))}
    </span>
  );
}
