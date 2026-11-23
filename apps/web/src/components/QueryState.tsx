import type { ReactNode } from 'react';
import { RefreshCw, ShieldAlert } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingBlock } from '@/components/ui/spinner';

interface QueryStateProps {
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty: boolean;
  filtered?: boolean;
  permissionDenied?: boolean;
  emptyTitle: string;
  emptyDescription: string;
  emptyIcon?: ReactNode;
}

/** 列表页面统一呈现加载、权限、失败、空数据和筛选无结果，避免失败伪装成空列表。 */
export function QueryState({
  isLoading,
  isError,
  error,
  onRetry,
  empty,
  filtered = false,
  permissionDenied = false,
  emptyTitle,
  emptyDescription,
  emptyIcon,
}: QueryStateProps) {
  if (permissionDenied) {
    return (
      <EmptyState
        icon={<ShieldAlert className="h-6 w-6" />}
        title="暂无访问权限"
        description="当前账号没有查看这类数据的权限，请联系管理员申请后重试。"
      />
    );
  }
  if (isLoading) return <LoadingBlock />;
  if (isError) {
    const forbidden = error instanceof ApiError && [401, 403].includes(error.status);
    return (
      <div role="alert" className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <ShieldAlert className="h-7 w-7 text-severity-medium" />
        <div>
          <div className="text-sm font-semibold text-slate-900">
            {forbidden ? '暂无访问权限' : '数据加载失败'}
          </div>
          <p className="mt-1 max-w-md text-xs leading-5 text-slate-500">
            {forbidden
              ? '当前账号没有查看这类数据的权限，请联系管理员。'
              : '本次请求未成功，历史数据没有被删除；请重试或检查服务状态。'}
          </p>
        </div>
        {onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            重试
          </Button>
        ) : null}
      </div>
    );
  }
  if (!empty) return null;
  return (
    <EmptyState
      icon={emptyIcon}
      title={filtered ? '没有匹配结果' : emptyTitle}
      description={filtered ? '请调整筛选条件后重试。' : emptyDescription}
    />
  );
}
