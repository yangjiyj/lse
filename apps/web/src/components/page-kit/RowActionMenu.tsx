import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface RowActionItem {
  key: string;
  label: ReactNode;
  /** 无障碍名称；label 含图标或附加文案时使用。 */
  ariaLabel?: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

interface RowActionMenuProps {
  items: RowActionItem[];
  label?: string;
  className?: string;
}

/**
 * 表格行「更多」菜单：次要操作收进弹层，保持每个操作仍可达。
 * 弹层挂到 body 并用 fixed 定位，避免被表格容器的 overflow 裁切。
 */
export function RowActionMenu({ items, label = '更多', className }: RowActionMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        triggerRef.current?.focus();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  if (items.length === 0) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex h-8 w-8 items-center justify-center rounded-[9px] text-ink-2 transition-colors hover:bg-slate-100 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          open && 'bg-slate-100 text-ink',
          className,
        )}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            style={{ position: 'fixed', top: pos.top, right: pos.right }}
            className="z-[60] min-w-[10rem] max-w-[18rem] rounded-xl border border-line bg-white p-1 shadow-pop"
          >
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                aria-label={item.ariaLabel}
                disabled={item.disabled}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] transition-colors hover:bg-brand-50 disabled:pointer-events-none disabled:opacity-50',
                  item.danger ? 'text-severity-critical hover:bg-severity-critical-bg' : 'text-ink',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
