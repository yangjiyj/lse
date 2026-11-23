import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** 侧边详情保留清单上下文，关闭后恢复焦点。 */
export function DetailDrawer({
  title,
  subtitle,
  children,
  onClose,
  size = 'md',
}: {
  title: string;
  /** 标题下的一行元信息（状态徽标、版本、数量等），不放说明句。 */
  subtitle?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  /** lg 用于放表格的抽屉（如关键词列表）。 */
  size?: 'md' | 'lg';
}) {
  const id = useId();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key !== 'Tab') return;
      const nodes = panel.current?.querySelectorAll<HTMLElement>(
        'button, a[href], input, select, textarea, [tabindex="0"]',
      );
      if (!nodes?.length) {
        e.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (
        e.shiftKey &&
        (document.activeElement === first || document.activeElement === panel.current)
      ) {
        e.preventDefault();
        last?.focus();
      } else if (
        !e.shiftKey &&
        (document.activeElement === last || document.activeElement === panel.current)
      ) {
        e.preventDefault();
        first?.focus();
      }
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 !m-0">
      <div className="absolute inset-0 bg-slate-950/20" aria-hidden="true" onClick={onClose} />
      <aside
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        className={`absolute inset-y-0 right-0 flex w-full ${size === 'lg' ? 'max-w-[780px]' : 'max-w-[470px]'} flex-col border-l border-line bg-white shadow-pop outline-none`}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
          <div className="min-w-0 space-y-1.5">
            <h2 id={id} className="break-words text-base font-semibold leading-6">
              {title}
            </h2>
            {subtitle && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
                {subtitle}
              </div>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="-mr-2 shrink-0"
            aria-label="关闭详情"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto break-words px-6 py-5 text-sm leading-6">
          {children}
        </div>
      </aside>
    </div>
  );
}
