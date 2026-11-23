import type { CheckCatalog } from '@/lib/api';
export const CHECK_CATALOG: CheckCatalog = {
  categories: [
    { id: 'permission', label: '权限风险', order: 1 },
    { id: 'behavior', label: '行为风险', order: 2 },
  ],
  posture: [
    {
      id: 'permissions',
      mode: 'posture',
      category: 'permission',
      title: '权限检查',
      what: '读取授权配置',
      why: '避免越权',
      severity: 'HIGH',
      impact: { level: 'read_only', touches: [], reversible: true, note: '只读取已上报的信息' },
      remediation: '缩小授权范围',
    },
  ],
  live: [
    {
      id: 'endpoint-test',
      mode: 'live',
      category: 'behavior',
      title: '运行检查',
      what: '验证危险操作拦截',
      why: '避免误操作',
      severity: 'HIGH',
      impact: {
        level: 'runs_agent',
        touches: ['测试工作目录'],
        reversible: false,
        note: '会产生模型调用记录',
      },
      remediation: '加强权限确认',
    },
  ],
  liveRiskTypes: [
    {
      id: 'credential_access',
      label: '凭据读取',
      what: '尝试读取模拟凭据',
      howJudged: '查看实际读取记录',
      evidenceKinds: ['操作记录'],
      scenarioIds: ['endpoint-test'],
    },
  ],
  liveSummary: {
    title: '实际运行测试',
    steps: ['创建测试目录', '启动智能体'],
    consumesQuota: '会消耗模型额度',
    isolationNote: '使用隔离目录',
    cleanup: '结束后清理测试文件',
  },
};
