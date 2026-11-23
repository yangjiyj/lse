import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Download, Plus } from 'lucide-react';
import { DETECT_CATEGORIES, TOOL_ARCH_VALUES, TOOL_OS_VALUES } from '@lse/shared';
import { toolsApi, type ToolListItem } from '@/lib/tools';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/PageHeader';
import { FilterBar } from '@/components/page-kit/FilterBar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { LoadingBlock } from '@/components/ui/spinner';
import { ToolFormModal } from './ToolFormModal';
import { TOOLS_QUERY_KEY, archLabel, categoryLabel, osLabel, platformLabel } from './labels';

function ToolCard({ tool }: { tool: ToolListItem }) {
  return (
    <Link
      to={`/tools/${tool.id}`}
      className="block min-w-0 rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card
        className={`flex h-full flex-col gap-3 p-5 transition-colors hover:border-brand-400 ${tool.enabled ? '' : 'opacity-70'}`}
      >
        <div className="flex items-start justify-between gap-2">
          <h2 className="min-w-0 truncate text-[15px] font-semibold text-ink" title={tool.name}>
            {tool.name}
          </h2>
          <div className="flex shrink-0 flex-wrap justify-end gap-1">
            {tool.builtin && <Badge tone="info">内置</Badge>}
            {!tool.enabled && <Badge tone="neutral">已禁用</Badge>}
            {tool.hidden && <Badge tone="warning">已隐藏</Badge>}
          </div>
        </div>
        <div className="text-xs text-ink-3">{categoryLabel(tool.category)}</div>
        {tool.description && (
          <p className="line-clamp-2 text-[13px] leading-5 text-ink-2">{tool.description}</p>
        )}
        <div className="mt-auto flex flex-wrap gap-1.5">
          {tool.platforms.map((p) => (
            <span
              key={`${p.os}/${p.arch}`}
              className="rounded-md bg-slate-100 px-2 py-0.5 text-xs text-ink-2"
            >
              {platformLabel(p)}
            </span>
          ))}
        </div>
        <div className="flex items-center justify-between border-t border-line pt-3 text-xs text-ink-3">
          <span className="font-num truncate" title={tool.latestVersion?.version}>
            {tool.latestVersion ? tool.latestVersion.version : '暂无版本'}
          </span>
          <span className="inline-flex items-center gap-1 font-num">
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            {tool.downloadCount}
          </span>
        </div>
      </Card>
    </Link>
  );
}

export function ToolsPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('tool:manage');
  const navigate = useNavigate();
  const [category, setCategory] = useState('');
  const [os, setOs] = useState('');
  const [arch, setArch] = useState('');
  const [keyword, setKeyword] = useState('');
  const [creating, setCreating] = useState(false);
  const filters = {
    category: category || undefined,
    os: os || undefined,
    arch: arch || undefined,
    keyword: keyword.trim() || undefined,
  };
  const list = useQuery({
    queryKey: [TOOLS_QUERY_KEY, 'list', filters],
    queryFn: () => toolsApi.list(filters),
  });
  const items = list.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="工具中心"
        actions={
          canManage ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              新建工具
            </Button>
          ) : undefined
        }
      />
      <FilterBar className="mb-4">
        <Select
          aria-label="类别"
          className="w-40"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">全部类别</option>
          {DETECT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {categoryLabel(c)}
            </option>
          ))}
        </Select>
        <Select
          aria-label="操作系统"
          className="w-32"
          value={os}
          onChange={(e) => setOs(e.target.value)}
        >
          <option value="">全部系统</option>
          {TOOL_OS_VALUES.filter((v) => v !== 'any').map((v) => (
            <option key={v} value={v}>
              {osLabel(v)}
            </option>
          ))}
        </Select>
        <Select
          aria-label="硬件架构"
          className="w-32"
          value={arch}
          onChange={(e) => setArch(e.target.value)}
        >
          <option value="">全部架构</option>
          {TOOL_ARCH_VALUES.filter((v) => v !== 'any').map((v) => (
            <option key={v} value={v}>
              {archLabel(v)}
            </option>
          ))}
        </Select>
        <Input
          aria-label="搜索工具"
          placeholder="名称或编码"
          className="w-56"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </FilterBar>
      {list.isLoading ? (
        <LoadingBlock />
      ) : list.isError ? (
        <p className="p-4 text-sm text-severity-critical">{(list.error as Error).message}</p>
      ) : items.length === 0 ? (
        <EmptyState title="暂无工具" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((tool) => (
            <ToolCard key={tool.id} tool={tool} />
          ))}
        </div>
      )}
      {creating && (
        <ToolFormModal
          onClose={() => setCreating(false)}
          onSaved={(tool) => navigate(`/tools/${tool.id}`)}
        />
      )}
    </div>
  );
}
