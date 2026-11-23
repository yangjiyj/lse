import {
  Activity,
  AlertTriangle,
  BookMarked,
  BookOpen,
  Boxes,
  Building2,
  CalendarClock,
  ClipboardList,
  Database,
  FileBarChart2,
  FileScan,
  FileSearch,
  GitCompareArrows,
  Laptop,
  LibraryBig,
  Layers3,
  ListFilter,
  LayoutDashboard,
  LayoutTemplate,
  LifeBuoy,
  ChartPie,
  IdCard,
  ListChecks,
  ListTodo,
  Network,
  NotebookTabs,
  Radar,
  Repeat2,
  Scale,
  Table2,
  TestTube2,
  ScrollText,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldHalf,
  Users,
  Workflow,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { DETECT_RISK_PERMISSIONS } from '@/lib/detect-risks';

// permission 为数组时满足任一即可（与后端 requirePermission(...codes) 同语义）；adminOnly 对应后端 requireAdmin。
export interface NavEntry {
  label: string;
  path: string;
  icon: LucideIcon;
  permission?: string | string[];
  adminOnly?: boolean;
  /** 仅平台租户的用户可用（平台设置、租户管理这类平台级页面）。 */
  platformOnly?: boolean;
  /** 平台管理员「全部租户」视角下可用的页面；未标记的页面在该视角下隐藏。 */
  allTenantsAllowed?: boolean;
  /** 安全设置把操作日志查看范围设为「仅平台管理员」时，只给平台管理员显示。 */
  followsAuditLogAccess?: boolean;
  hint?: string;
}
export interface NavGroup {
  label?: string;
  items: NavEntry[];
}
export interface NavSection {
  label: string;
  groups: NavGroup[];
}

// 仅配置已存在的页面。后续 W1-W6 在对应分组追加真实页面，不添加占位入口。
export const NAV_SECTIONS: NavSection[] = [
  {
    label: '工作台',
    groups: [
      {
        items: [
          { path: '/', allTenantsAllowed: true, label: '态势概览', icon: LayoutDashboard },
          { path: '/my-todos', allTenantsAllowed: true, label: '我的待办', icon: ListTodo, permission: 'eval_task:read' },
          {
            path: '/detect-tasks',
            allTenantsAllowed: true,
            label: '全部任务',
            icon: ClipboardList,
            permission: 'detect_task:read',
          },
        ],
      },
    ],
  },
  {
    label: '评估中心',
    groups: [
      {
        label: '评估',
        items: [
          {
            path: '/model-targets', allTenantsAllowed: true,
            label: '评估对象',
            icon: Boxes,
            permission: 'model_target:read',
          },
          { path: '/fleet', allTenantsAllowed: true, label: '终端与智能体', icon: Laptop, permission: 'model_target:read' },
          { path: '/ledger', label: '应用台账', icon: NotebookTabs, permission: 'ledger:read' },
          {
            path: '/eval-tasks', allTenantsAllowed: true,
            label: '评估任务',
            icon: ListChecks,
            permission: 'eval_task:read',
          },
          {
            path: '/batch-evaluations',
            label: '批量评估',
            icon: Layers3,
            permission: 'eval_task:read',
          },
          {
            path: '/detect-tasks/jobs',
            label: '组合任务',
            icon: Workflow,
            permission: 'detect_task:read',
          },
          {
            path: '/question-sets',
            label: '模型题库',
            icon: Database,
            permission: 'question_set:read',
          },
          { path: '/agent-samples', label: '智能体样本库', icon: LibraryBig, permission: 'model_target:read' },
          { path: '/agent-range', label: '测评靶场', icon: TestTube2, permission: 'eval_task:read' },
          {
            path: '/eval-tasks/compare',
            label: '任务对比',
            icon: GitCompareArrows,
            permission: 'eval_task:read',
          },
        ],
      },
      {
        label: '持续评估',
        items: [
          {
            path: '/eval/plans',
            label: '评估计划',
            icon: CalendarClock,
            permission: 'eval_task:read',
          },
          {
            path: '/detect-tasks/strategies',
            label: '检测策略',
            icon: Repeat2,
            permission: 'detect_task:read',
          },
          {
            path: '/eval/gates',
            label: '上线门禁',
            icon: ShieldAlert,
            permission: ['gate:read', 'gate:manage'],
          },
        ],
      },
    ],
  },
  {
    label: '专项核验',
    groups: [
      {
        label: '专项核验',
        items: [
          {
            path: '/service-assurance',
            label: 'AI 服务安全核验',
            icon: ShieldCheck,
            permission: 'service_assurance:read',
          },
          {
            path: '/ai-asset-scan',
            label: 'AI 组件漏洞扫描',
            icon: ShieldHalf,
            permission: 'engine:scan',
          },
          {
            path: '/inspect/model-files',
            label: '模型文件扫描',
            icon: FileSearch,
            permission: ['engine:scan', 'remediation:read'],
          },
          {
            path: '/inspect/asset-discovery',
            label: 'AI 资产测绘',
            icon: Radar,
            permission: ['engine:scan', 'platform_setting:read'],
          },
          {
            path: '/inspect/rag',
            label: 'RAG 专项评估',
            icon: BookOpen,
            permission: 'rag_eval:read',
          },
        ],
      },
    ],
  },
  {
    label: '工具中心',
    groups: [
      {
        items: [
          {
            path: '/tools',
            allTenantsAllowed: true,
            label: '工具中心',
            icon: Wrench,
            permission: 'tool:read',
          },
        ],
      },
    ],
  },
  {
    label: '数据安全',
    groups: [
      {
        label: '数据安全',
        items: [
          { path: '/data/corpus-scans', label: '语料扫描', icon: FileScan, permission: 'corpus_scan:read' },
          {
            path: '/data/corpus-rules',
            label: '语料规则',
            icon: ListFilter,
            permission: ['corpus_scan:read', 'corpus_rule:manage'],
          },
        ],
      },
    ],
  },
  {
    label: '数据分析',
    groups: [
      {
        items: [
          {
            path: '/analysis/results',
            allTenantsAllowed: true,
            label: '检测结果',
            icon: ChartPie,
            permission: [...DETECT_RISK_PERMISSIONS],
          },
          {
            // 与应用台账一样，不进「全部租户」视角。
            path: '/analysis/profiles',
            label: '应用画像',
            icon: IdCard,
            permission: 'ledger:read',
          },
        ],
      },
    ],
  },
  {
    label: '风险处置',
    groups: [
      {
        label: '风险与整改',
        items: [
          {
            path: '/wrong-answers', allTenantsAllowed: true,
            label: '风险处置台',
            icon: AlertTriangle,
            permission: 'wrong_answer:export',
          },
          {
            path: '/risk/policy-suggestions',
            label: '策略建议与下发',
            icon: Shield,
            permission: 'remediation:read',
          },
        ],
      },
    ],
  },
  {
    label: '报告中心',
    groups: [
      {
        label: '报告',
        items: [
          { path: '/reports', allTenantsAllowed: true, label: '报告管理', icon: FileBarChart2, permission: 'report:read' },
          {
            path: '/reports/standard-clauses',
            label: '国内标准条款',
            icon: Scale,
            permission: 'eval_task:read',
          },
          {
            path: '/reports/framework-coverage',
            label: '框架覆盖',
            icon: Table2,
            permission: 'eval_task:read',
          },
          {
            path: '/reports/templates',
            label: '报告模板',
            icon: LayoutTemplate,
            permission: 'report:read',
          },
        ],
      },
    ],
  },
  {
    label: '系统管理',
    groups: [
      {
        label: '系统',
        items: [
          { path: '/users', allTenantsAllowed: true, label: '用户与权限', icon: Users, permission: 'user:read' },
          {
            path: '/system/organizations',
            allTenantsAllowed: true,
            label: '组织架构',
            icon: Network,
            permission: 'org:read',
          },
          {
            path: '/tenants', allTenantsAllowed: true,
            label: '租户管理',
            icon: Building2,
            permission: 'tenant:manage',
            platformOnly: true,
          },
          {
            path: '/settings', allTenantsAllowed: true,
            label: '平台设置',
            icon: Settings,
            permission: 'platform_setting:read',
            platformOnly: true,
          },
          {
            path: '/audit-logs', allTenantsAllowed: true,
            label: '操作日志',
            icon: ScrollText,
            permission: 'audit_log:read',
            followsAuditLogAccess: true,
          },
          {
            path: '/system/status',
            allTenantsAllowed: true,
            label: '运行状态',
            icon: Activity,
            permission: 'tenant:manage',
            platformOnly: true,
          },
          {
            path: '/system/dictionaries', allTenantsAllowed: true,
            label: '数据字典',
            icon: BookMarked,
            permission: 'system_setting:read',
            platformOnly: true,
          },
          {
            path: '/system/support-tickets', allTenantsAllowed: true,
            label: '工单处理',
            icon: LifeBuoy,
            permission: 'support:manage',
            platformOnly: true,
          },
        ],
      },
    ],
  },
];

// W4 策略建议；W5 模型文件扫描与 AI 资产测绘；W6 RAG 专项评估。
// 页面实现后仅向对应 section.groups[].items 追加真实页面，不添加占位入口。
