import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

type ToastKind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}
interface ToastContextValue {
  toast: (message: string, kind?: ToastKind) => void;
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const ICON: Record<ToastKind, ReactNode> = {
  success: <CheckCircle2 className="h-4 w-4 text-severity-pass" />,
  error: <AlertCircle className="h-4 w-4 text-destructive" />,
  info: <Info className="h-4 w-4 text-primary" />,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const timers = useRef(new Map<number, number>());

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) window.clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  const remove = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(id);
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      counter.current += 1;
      const id = counter.current;
      setItems((prev) => [...prev, { id, kind, message }]);
      timers.current.set(
        id,
        window.setTimeout(() => remove(id), 4000),
      );
    },
    [remove],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      toast,
      success: (m: string) => toast(m, 'success'),
      error: (m: string) => toast(m, 'error'),
    }),
    [toast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              'flex items-start gap-2.5 rounded-xl border border-line bg-card p-3.5 text-sm shadow-pop',
            )}
          >
            <span className="mt-0.5">{ICON[t.kind]}</span>
            <span className="flex-1 text-foreground">{t.message}</span>
            <button
              type="button"
              onClick={() => remove(t.id)}
              className="text-ink-3 hover:text-ink"
              aria-label="关闭提示"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast 必须在 ToastProvider 内部使用');
  return ctx;
}

/**
 * 在没有 ToastProvider 时安全返回 null（不抛错），
 * 适用于既可能在 Provider 内、也可能被裸渲染的外层框架组件。
 */
export function useOptionalToast(): ToastContextValue | null {
  return useContext(ToastContext);
}
