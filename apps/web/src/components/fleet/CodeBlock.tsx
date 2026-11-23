import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { copyText } from '@/lib/fleet';

export function CodeBlock({
  label,
  text,
  copyLabel,
}: {
  label: string;
  text: string;
  copyLabel?: string;
}) {
  const toast = useToast();
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold text-ink">{label}</span>
        <Button
          size="sm"
          variant="outline"
          aria-label={copyLabel ?? `复制：${label}`}
          onClick={async () => {
            if (await copyText(text)) toast.success('已复制');
            else toast.error('复制失败，请手动选中复制');
          }}
        >
          <Copy className="h-3.5 w-3.5" />
          复制
        </Button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-xl border border-line bg-[#F7F9FD] px-4 py-3 font-mono text-[12.5px] leading-6 text-ink-2">
        {text}
      </pre>
    </div>
  );
}
