import type { EndpointOverview } from '../../../../../packages/shared/src/endpoint-overview';

/** 脱敏大样本：88 个技能、8 类智能体、7 类问题。 */
export const overviewFixture: EndpointOverview = {
  endpointId: 'ep1',
  platforms: [],
  report: { reportId: 'r1', scannedAt: '2026-10-25T02:30:00Z', probeVersion: '1.2.3' },
  counts: {
    openRisks: 5,
    highRisks: 2,
    reviewItems: 1,
    agentKinds: 8,
    agentInstalls: 8,
    skills: 88,
    mcpServers: 1,
    notCheckedKinds: 1,
    notCheckedInstalls: 2,
  },
  risks: Array.from({ length: 7 }, (_, i) => ({
    id: `risk-${i}`,
    level: i === 5 ? 'REVIEW' : i === 6 ? 'NOT_CHECKED' : i < 2 ? 'HIGH' : i < 4 ? 'MEDIUM' : 'LOW',
    category: 'permission',
    title: i === 6 ? '部分配置没检查' : `权限问题 ${i + 1}`,
    involved: '2 个智能体',
    basis: i === 6 ? '终端没有读取权限' : '读取到过宽的权限',
    advice: i === 6 ? '授权后重新上报' : '收紧授权后重新检测',
    subjectCount: 3,
    subjects: [{ name: 'Claude Code', detail: '用户配置' }],
    moreCount: 2,
  })),
  agents: Array.from({ length: 8 }, (_, i) => ({
    key: i === 0 ? 'claude-code' : i === 1 ? 'openclaw' : `agent-${i}`,
    name: i === 0 ? 'Claude Code' : i === 1 ? 'OpenClaw' : `智能体 ${i + 1}`,
    version: '1.0',
    installs: 1,
    configState: i === 7 ? 'not_checked' : 'checked',
    configItems: (['permission', 'auto_approval', 'sandbox'] as const).map((item) => ({
      item,
      state: i === 7 ? ('unknown' as const) : ('explicit' as const),
      installs: 1,
    })),
    configNote: i === 7 ? '终端没有读取权限；请授权后重新上报' : null,
    issues: 1,
    liveEval: {
      supported: i < 2,
      registered: i === 0,
      reason: i === 1 ? '尚未登记，请联系终端管理员' : null,
    },
  })),
  skills: Array.from({ length: 88 }, (_, i) => ({
    name: `技能 ${String(i + 1).padStart(2, '0')}`,
    sourceLabel: i === 2 ? '来源未知' : '本地目录',
    sourceState: i === 2 ? 'unknown' : 'known',
    installedIn: ['Claude Code'],
    installs: 1,
    state: i === 0 ? 'review' : i === 1 ? 'not_checked' : 'clear',
    hits:
      i === 0
        ? [
            {
              rule: 'test',
              label: '包含下载说明',
              file: 'README.md',
              line: 8,
              contextType: 'document',
            },
          ]
        : [],
  })),
  mcp: [
    {
      name: '文件服务',
      transport: 'stdio',
      scope: '用户',
      installedIn: ['Claude Code'],
      state: 'not_checked',
      checks: [
        { label: '权限范围', state: 'unknown' },
        { label: '来源', state: 'pass' },
        { label: '凭据', state: 'finding' },
      ],
    },
  ],
  history: [
    {
      taskId: 't1',
      mode: 'posture',
      modeLabel: '配置体检',
      createdAt: '2026-10-25T02:30:00Z',
      status: 'COMPLETED',
      summaryLine: '发现 5 类风险',
    },
  ],
};

/** 同产品多安装的大样本：counts 的每一项是一个产品的安装行数，各行位置与账号互不相同。 */
export function installRowsFixture(
  counts: number[],
  patch: (row: EndpointOverview['agents'][number], p: number, i: number) => void = () => {},
): EndpointOverview['agents'] {
  return counts.flatMap((count, p) =>
    Array.from({ length: count }, (_, i) => {
      const row: EndpointOverview['agents'][number] = {
        key: `product-${p}`,
        name: `产品 ${p + 1}`,
        version: '1.0',
        installs: 1,
        configState: 'unrecorded',
        configItems: [],
        configNote: null,
        issues: 0,
        liveEval: { supported: false, registered: false, reason: null },
        location: `~/.产品${p + 1}-安装${i + 1}`,
        account: `账号${i + 1}`,
      };
      patch(row, p, i);
      return row;
    }),
  );
}
