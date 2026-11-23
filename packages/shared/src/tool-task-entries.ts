import type { DetectCategory } from './detect-category.js';

/**
 * 工具中心「新建任务」「任务列表」的跳转白名单（2.3.6、2.3.10）。
 * 工具只存这里的 key，前端只按这里的路径跳转，不存任意 URL。路径是各页面现有路由（apps/web/src/App.tsx）。
 */
export interface ToolTaskEntry {
  key: string;
  label: string;
  category: DetectCategory;
  createPath: string;
  listPath: string;
  /** 目标页建任务所需的权限码；要求多个时全部都要有。没有时「新建任务」置灰。 */
  permission: string | readonly string[];
}

function entry<K extends string>(
  key: K,
  label: string,
  category: DetectCategory,
  createPath: string,
  listPath: string,
  permission: string | readonly string[],
): ToolTaskEntry & { key: K } {
  return { key, label, category, createPath, listPath, permission };
}

export const TOOL_TASK_ENTRIES = {
  'content-eval': entry(
    'content-eval',
    '内容安全评估',
    'content',
    '/eval-tasks?launch=content',
    '/eval-tasks',
    'eval_task:create',
  ),
  'standard-eval': entry(
    'standard-eval',
    '合规专项检测',
    'content',
    '/eval-tasks?launch=standard',
    '/eval-tasks',
    'eval_task:create',
  ),
  'red-team': entry(
    'red-team',
    '多轮对抗演练',
    'content',
    '/eval-tasks?launch=redteam',
    '/eval-tasks',
    'eval_task:create',
  ),
  'model-file-scan': entry(
    'model-file-scan',
    '模型文件扫描',
    'model',
    '/inspect/model-files',
    '/inspect/model-files',
    'engine:scan',
  ),
  'asset-discovery': entry(
    'asset-discovery',
    'AI 资产测绘',
    'app_env',
    '/inspect/asset-discovery',
    '/inspect/asset-discovery',
    'engine:scan',
  ),
  'service-assurance': entry(
    'service-assurance',
    'AI 服务安全核验',
    'app_env',
    '/service-assurance',
    '/service-assurance',
    'service_assurance:scan',
  ),
  'ai-component-scan': entry(
    'ai-component-scan',
    'AI 组件漏洞扫描',
    'app_env',
    '/ai-asset-scan',
    '/ai-asset-scan',
    'engine:scan',
  ),
  'fleet-onboard': entry(
    'fleet-onboard',
    '终端接入',
    'app_env',
    '/fleet?tab=enroll',
    '/fleet?tab=endpoints',
    'model_target:create',
  ),
  // 终端测评任务要同时能登记评估对象和建评估任务（与智能体清单里「发起测评」一致）。
  'fleet-eval': entry('fleet-eval', '终端测评', 'app_env', '/fleet?tab=jobs', '/fleet?tab=jobs', [
    'model_target:create',
    'eval_task:create',
  ]),
  // 终端配置体检（组合任务的子任务）：权限与终端测评相同，在终端列表里发起。
  'fleet-posture': entry(
    'fleet-posture',
    '终端配置体检',
    'app_env',
    '/fleet?tab=endpoints',
    '/fleet?tab=endpoints',
    ['model_target:create', 'eval_task:create'],
  ),
  'corpus-scan': entry(
    'corpus-scan',
    '语料扫描',
    'data',
    '/data/corpus-scans?new=1',
    '/data/corpus-scans',
    'corpus_scan:create',
  ),
} as const satisfies Record<string, ToolTaskEntry>;

export type ToolTaskEntryKey = keyof typeof TOOL_TASK_ENTRIES;

export const TOOL_TASK_ENTRY_KEYS = Object.keys(TOOL_TASK_ENTRIES) as ToolTaskEntryKey[];

export function isToolTaskEntryKey(value: unknown): value is ToolTaskEntryKey {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(TOOL_TASK_ENTRIES, value)
  );
}

/** 当前用户能不能在目标页建任务：入口要求的权限码全部都有。 */
export function canCreateToolTask(
  entry: Pick<ToolTaskEntry, 'permission'>,
  hasPermission: (code: string) => boolean,
): boolean {
  const codes = typeof entry.permission === 'string' ? [entry.permission] : entry.permission;
  return codes.every((code) => hasPermission(code));
}

/** 按 key 取入口；不在白名单里返回 null。 */
export function toolTaskEntry(key: string | null | undefined): ToolTaskEntry | null {
  return isToolTaskEntryKey(key) ? TOOL_TASK_ENTRIES[key] : null;
}
