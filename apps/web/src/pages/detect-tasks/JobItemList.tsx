import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { X } from 'lucide-react';
import { DETECT_JOB_ITEM_KINDS, DETECT_JOB_ITEM_META, type DetectJobItemKind } from '@lse/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useAuth } from '@/lib/auth';
import type { DetectJobItemInput } from '@/lib/detect-tasks';
import { toolsApi } from '@/lib/tools';
import {
  JobItemEditor,
  defaultJobItemParams,
  jobItemProblem,
  normalizeJobItemParams,
  type JobItemIssue,
  type JobItemParams,
} from './JobItemEditor';

/** 与后端 DETECT_JOB_MAX_ITEMS、DETECT_JOB_MAX_PARALLEL 一致。 */
export const JOB_MAX_ITEMS = 20;
export const JOB_MAX_PARALLEL = 10;

export interface JobItemDraft {
  key: string;
  kind: DetectJobItemKind;
  title: string;
  toolId: string | null;
  ledgerAssetId: string | null;
  params: JobItemParams;
  problem: string | null;
  /** 后端指出的这一项的问题（提交后返回「第 N 项」时落到这里，改这一项时清掉） */
  serverError?: string | null;
  /** 用户动过这一项的参数：动过才显示还缺什么 */
  touched?: boolean;
  serverIssues?: JobItemIssue[];
}

let seq = 0;
const nextKey = () => `job-item-${++seq}`;

export function draftFromInput(item: DetectJobItemInput): JobItemDraft {
  const params = normalizeJobItemParams(item.kind, item.params);
  return {
    key: nextKey(),
    kind: item.kind,
    title: item.title ?? '',
    toolId: item.toolId ?? null,
    ledgerAssetId: item.ledgerAssetId ?? null,
    params,
    problem: jobItemProblem(item.kind, params),
  };
}

export function draftToInput(d: JobItemDraft): DetectJobItemInput {
  return {
    kind: d.kind,
    ...(d.title.trim() ? { title: d.title.trim() } : {}),
    params: d.params,
    toolId: d.toolId,
    ...(d.ledgerAssetId ? { ledgerAssetId: d.ledgerAssetId } : {}),
  };
}

/**
 * 提交后后端返回「第 N 项」的错误（400 DETECT_JOB_ITEM_INVALID 等带 details.index）：落到对应子任务，
 * 显示第一条具体原因；落不到某一项的返回给页面底部显示。
 */
export function placeServerError(
  items: JobItemDraft[],
  err: unknown,
): { items: JobItemDraft[]; message: string | null } {
  const message = err instanceof Error ? err.message : String(err);
  const details = (err instanceof ApiError ? err.issues : undefined) as
    | { index?: unknown; issues?: Array<{ path?: unknown[]; message?: string }> }
    | undefined;
  const index = typeof details?.index === 'number' ? details.index : -1;
  if (index < 0 || !items[index]) return { items, message };
  const issues: JobItemIssue[] = (details?.issues ?? []).map((i) => ({
    path: (i.path ?? []).join('.'),
    message: i.message ?? message,
  }));
  return {
    items: items.map((item, i) =>
      i === index
        ? { ...item, serverError: issues[0]?.message ?? message, serverIssues: issues }
        : item,
    ),
    message: null,
  };
}

interface AddOption {
  value: string;
  label: string;
  kind: DetectJobItemKind;
  toolId: string | null;
}

/**
 * 添加子任务先选工具：工具中心里登记了可自动执行入口（taskEntry）的工具；
 * 工具中心没有对应工具（或没有查看工具的权限）的类型按类型名列出。没有发起权限的类型不列。
 */
function useAddOptions(): AddOption[] {
  const { hasPermission } = useAuth();
  const tools = useQuery({
    queryKey: ['tools', 'job-item-options'],
    queryFn: () => toolsApi.list(),
    enabled: hasPermission('tool:read'),
  });
  const canLaunch = (kind: DetectJobItemKind) =>
    DETECT_JOB_ITEM_META[kind].createPermissions.every((p) => hasPermission(p));
  const kindOf = (entry: string | null) =>
    DETECT_JOB_ITEM_KINDS.find((k) => DETECT_JOB_ITEM_META[k].entry === entry);
  const fromTools = (tools.data?.items ?? []).flatMap((t): AddOption[] => {
    const kind = t.enabled && !t.hidden ? kindOf(t.taskEntry) : undefined;
    return kind && canLaunch(kind)
      ? [{ value: `tool:${t.id}`, label: t.name, kind, toolId: t.id }]
      : [];
  });
  const covered = new Set(fromTools.map((o) => o.kind));
  const fromKinds = DETECT_JOB_ITEM_KINDS.filter((k) => !covered.has(k) && canLaunch(k)).map(
    (k): AddOption => ({
      value: `kind:${k}`,
      label: DETECT_JOB_ITEM_META[k].label,
      kind: k,
      toolId: null,
    }),
  );
  return [...fromTools, ...fromKinds];
}

/** 子任务清单：逐项填参数，组合任务和检测策略共用。 */
export function JobItemList({
  items,
  onChange,
  showProblems = false,
}: {
  items: JobItemDraft[];
  onChange: (items: JobItemDraft[]) => void;
  /** 点过提交后为 true：没动过的子任务也显示还缺什么 */
  showProblems?: boolean;
}) {
  const options = useAddOptions();
  const add = (value: string) => {
    const option = options.find((o) => o.value === value);
    if (!option) return;
    const params = defaultJobItemParams(option.kind);
    onChange([
      ...items,
      {
        key: nextKey(),
        kind: option.kind,
        title: option.label,
        toolId: option.toolId,
        ledgerAssetId: null,
        params,
        problem: jobItemProblem(option.kind, params),
      },
    ]);
  };
  const patch = (key: string, change: Partial<JobItemDraft>) =>
    onChange(items.map((i) => (i.key === key ? { ...i, ...change } : i)));

  return (
    <div className="space-y-3">
      {items.map((item, index) => (
        <section
          key={item.key}
          aria-label={`第 ${index + 1} 项`}
          className="rounded-xl border border-line p-4"
        >
          <div className="mb-3 flex items-center gap-2">
            <span className="shrink-0 text-[13px] font-semibold text-ink-3">
              {index + 1}. {DETECT_JOB_ITEM_META[item.kind].label}
            </span>
            <Input
              aria-label={`第 ${index + 1} 项名称`}
              value={item.title}
              maxLength={200}
              onChange={(e) => patch(item.key, { title: e.target.value })}
              className="h-8 flex-1"
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={`移除第 ${index + 1} 项`}
              onClick={() => onChange(items.filter((i) => i.key !== item.key))}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <JobItemEditor
            kind={item.kind}
            value={item.params}
            issues={item.serverIssues}
            onChange={(params, problem) =>
              patch(item.key, {
                params,
                problem,
                touched: true,
                serverError: null,
                serverIssues: undefined,
              })
            }
          />
          {/* problem 照常交给父组件控制按钮；提示等用户动过这一项或点过提交才显示 */}
          {(item.serverError || (item.problem && (item.touched || showProblems))) && (
            <p
              className={`mt-2 text-[12.5px] ${item.serverError ? 'text-destructive' : 'text-severity-medium'}`}
            >
              {item.serverError ?? item.problem}
            </p>
          )}
        </section>
      ))}
      <Select
        aria-label="添加子任务"
        value=""
        disabled={items.length >= JOB_MAX_ITEMS || options.length === 0}
        onChange={(e) => add(e.target.value)}
      >
        <option value="">添加子任务…</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </div>
  );
}
