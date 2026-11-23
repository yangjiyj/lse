import { Link, useLocation } from 'react-router-dom';
import { SearchX } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';

/** 登录态下访问了不存在的地址：明确告诉用户链接不对，并给出回首页的出路（不再静默跳走）。 */
export function NotFoundPage() {
  const { pathname } = useLocation();
  return (
    <div className="mx-auto max-w-xl pt-10">
      <EmptyState
        icon={<SearchX className="h-7 w-7" aria-hidden="true" />}
        title="页面不存在"
        description="你访问的地址没有对应的页面，可能是链接有误或页面已调整。"
        action={
          <div className="flex min-w-0 max-w-full flex-col items-center gap-3">
            <p className="max-w-full break-all rounded-md bg-canvas px-3 py-1.5 font-mono text-xs text-ink-3">
              {pathname}
            </p>
            <Link
              to="/"
              className="inline-flex h-9 items-center rounded-[10px] bg-gradient-to-b from-brand-500 to-brand-600 px-4 text-[13.5px] font-semibold text-white shadow-btn hover:from-brand-600 hover:to-brand-700"
            >
              返回首页
            </Link>
          </div>
        }
      />
    </div>
  );
}
