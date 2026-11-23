import type { ReactNode } from 'react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

const SIZE: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-3xl',
  xl: 'max-w-6xl',
};

// 本组件自己渲染的对话框带 data-modal-dialog 标记，用来和调用方自行写的 role="dialog" 区分开。
const HAND_WRITTEN_DIALOG = '[role="dialog"]:not([data-modal-dialog])';

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: ModalProps) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const descriptionId = `${uid}-description`;
  const panelRef = useRef<HTMLDivElement>(null);
  // 个别页面在 Modal 外层或内容里已经自己写了 role="dialog"（旧写法）：此时不再重复声明，
  // 否则读屏和按名称查找会看到两个同名对话框。
  const [hasOwnDialog, setHasOwnDialog] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    setHasOwnDialog(
      Boolean(
        panel?.parentElement?.closest(HAND_WRITTEN_DIALOG) ??
        panel?.querySelector(HAND_WRITTEN_DIALOG),
      ),
    );
  }, [open]);

  if (!open) return null;

  const dialogProps = hasOwnDialog
    ? {}
    : {
        role: 'dialog' as const,
        'aria-modal': true as const,
        'aria-labelledby': title ? titleId : undefined,
        'aria-describedby': description ? descriptionId : undefined,
      };

  // 遮罩用 !m-0：弹窗常渲染在 space-y-* 容器里，该规则会给 fixed 遮罩加上外边距，使遮罩顶部露出一条缝。
  return (
    <div className="fixed inset-0 !m-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/40 backdrop-blur-[2px] p-3 pt-[6vh] sm:p-4 sm:pt-[8vh]">
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        data-modal-dialog=""
        {...dialogProps}
        className={cn(
          'relative w-full overflow-hidden rounded-[18px] border border-line bg-white shadow-pop',
          SIZE[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
          <div className="min-w-0 flex flex-col gap-1">
            {title && (
              <h2 id={titleId} className="text-[17px] font-bold text-ink">
                {title}
              </h2>
            )}
            {description && (
              <p id={descriptionId} className="text-sm leading-6 text-ink-3">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-ink"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[68vh] overflow-auto break-words p-6 scrollbar-thin">{children}</div>
        {footer && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-[#F8FAFD] px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
