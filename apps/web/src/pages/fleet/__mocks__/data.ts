import type {
  FleetDeploymentInfo,
  FleetEndpoint,
  FleetEnrollmentCode,
  FleetJob,
  FleetUserRef,
} from '@/lib/api';

// 夹具按后端 /api/fleet/* 的真实返回结构编写（字段取自联调时的真实响应）。
const now = Date.now();
const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3600_000).toISOString();
const future = (hours: number) => new Date(now + hours * 3600_000).toISOString();

const admin: FleetUserRef = { id: 'u-admin', username: 'admin', displayName: '超级管理员' };
const other: FleetUserRef = { id: 'u-other', username: 'zhangwei', displayName: '张伟' };

function endpoint(
  partial: Partial<FleetEndpoint> & Pick<FleetEndpoint, 'id' | 'hostname'>,
): FleetEndpoint {
  return {
    publicId: `ep_${partial.id}`,
    platform: 'jiandun',
    os: 'linux',
    osVersion: 'Ubuntu 24.04',
    arch: 'x86_64',
    osUser: 'yj',
    agentVersion: '1.8.2',
    capabilities: [],
    status: 'ACTIVE',
    online: true,
    lastSeenAt: iso(0.1),
    evalRunner: '1',
    agents: [],
    registeredAt: iso(48),
    revokedAt: null,
    enrollmentCode: { id: 'c1', label: '研发部第一批', codePrefix: 'jdc_RVfF' },
    latestReport: {
      reportId: `pr_${partial.id}`,
      scannedAt: iso(2),
      status: 'complete',
      assetCount: 14,
    },
    ...partial,
  };
}

export const MOCK_ENDPOINTS: FleetEndpoint[] = [
  endpoint({
    id: 'ep1',
    hostname: 'demo-host',
    agents: [{ product: 'claude-code', version: '2.1.0', headlessCapable: true }],
  }),
  endpoint({
    id: 'ep2',
    hostname: 'YJ40B4',
    os: 'windows',
    osVersion: '11 23H2',
    arch: 'x64',
    osUser: 'zhangwei',
    online: false,
    lastSeenAt: iso(80),
    evalRunner: null,
    latestReport: { reportId: 'pr_ep2', scannedAt: iso(90), status: 'complete', assetCount: 6 },
  }),
  endpoint({
    id: 'ep3',
    hostname: 'mac-design-03',
    os: 'darwin',
    osVersion: '15.1',
    arch: 'arm64',
    osUser: 'lina',
    latestReport: null,
  }),
  // Windows 终端上报了测评执行器：与其他系统一样支持真机测评（不再按系统一刀切置灰）
  endpoint({
    id: 'ep4',
    hostname: 'win-runner-01',
    os: 'windows',
    osVersion: '11 23H2',
    arch: 'x64',
    evalRunner: '1',
  }),
  endpoint({
    id: 'ep5',
    hostname: 'old-box',
    status: 'REVOKED',
    online: false,
    revokedAt: iso(5),
  }),
];

function job(
  partial: Partial<FleetJob> & Pick<FleetJob, 'id' | 'endpointId' | 'status'>,
): FleetJob {
  const host = MOCK_ENDPOINTS.find((e) => e.id === partial.endpointId)!;
  return {
    publicId: `lej_${partial.id}`,
    endpoint: { id: host.id, publicId: host.publicId, hostname: host.hostname },
    evalTaskId: `task-${partial.id}`,
    product: 'claude-code',
    checksum: 'a'.repeat(64),
    scenarioCount: 6,
    statusLabel: partial.status,
    reason: '例行复测',
    rejectReason: null,
    errorCode: null,
    requestedBy: admin,
    approvedBy: null,
    approvedAt: null,
    deadline: future(20),
    deliveredAt: null,
    startedAt: null,
    finishedAt: null,
    createdAt: iso(1),
    updatedAt: iso(1),
    ...partial,
  };
}

export const MOCK_JOBS: FleetJob[] = [
  job({
    id: 'job1',
    endpointId: 'ep1',
    status: 'PENDING_APPROVAL',
    reason: '新版本上线前验证危险命令拦截',
    requestedBy: other,
  }),
  job({ id: 'job2', endpointId: 'ep3', status: 'PENDING_APPROVAL', reason: '季度例行真机复测' }),
  job({
    id: 'job3',
    endpointId: 'ep1',
    status: 'RUNNING',
    product: 'codex',
    reason: '补测 Codex 工具调用',
    approvedBy: other,
    approvedAt: iso(5),
  }),
  job({
    id: 'job4',
    endpointId: 'ep1',
    status: 'COMPLETED',
    reason: '发布前复测',
    evalTaskId: 'task-abc',
    approvedBy: other,
    finishedAt: iso(28),
  }),
  job({
    id: 'job5',
    endpointId: 'ep2',
    status: 'REJECTED',
    product: 'codex',
    reason: '想看看 Codex 的表现',
    rejectReason: '该终端正在做版本升级，下周再申请',
  }),
  job({
    id: 'job6',
    endpointId: 'ep2',
    status: 'FAILED',
    reason: '例行复测',
    approvedBy: other,
    errorCode: 'RUNNER_TIMEOUT',
  }),
];

function code(partial: Partial<FleetEnrollmentCode> & Pick<FleetEnrollmentCode, 'id' | 'label'>) {
  return {
    codePrefix: 'jdc_AAAA',
    maxUses: 1,
    usedCount: 0,
    remainingUses: 1,
    endpointCount: 0,
    status: 'ACTIVE',
    expiresAt: future(30),
    createdAt: iso(18),
    revokedAt: null,
    createdBy: admin,
    ...partial,
  } as FleetEnrollmentCode;
}

export const MOCK_CODES: FleetEnrollmentCode[] = [
  code({
    id: 'c1',
    label: '研发部第一批',
    codePrefix: 'jdc_4F2A',
    maxUses: 20,
    usedCount: 7,
    remainingUses: 13,
    endpointCount: 7,
  }),
  code({
    id: 'c2',
    label: '测试用（已用完）',
    codePrefix: 'jdc_91BC',
    usedCount: 1,
    remainingUses: 0,
    endpointCount: 1,
    status: 'EXHAUSTED',
  }),
  code({
    id: 'c3',
    label: '误建的码',
    codePrefix: 'jdc_0D7E',
    maxUses: 5,
    remainingUses: 5,
    status: 'REVOKED',
    revokedAt: iso(3),
    createdBy: null,
  }),
  code({
    id: 'c4',
    label: '过期的码',
    codePrefix: 'jdc_77AA',
    status: 'EXPIRED',
    expiresAt: iso(20),
  }),
];

export const MOCK_DEPLOYMENT_READY: FleetDeploymentInfo = {
  ready: true,
  issues: [],
  warnings: [],
  server: 'https://jiandun.example.com:8453',
  certificate: {
    pem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
    sha256: 'a3f1c0d94b7e2268c5d1e9f03ab47c8d6e5f10293847abcd5566778899aabbcc',
    subject: 'CN=t',
    issuer: 'CN=t',
    validFrom: iso(1),
    validTo: future(47),
    selfSigned: true,
    hostMatches: true,
  },
  tlsDeployment: {
    server: 'https://jiandun.example.com:8453',
    tls_server_cert_pem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
    tls_server_cert_sha256: 'a3f1c0d94b7e2268c5d1e9f03ab47c8d6e5f10293847abcd5566778899aabbcc',
  },
  collectorConfigPatch: {
    managed_config: false,
    system_audit: false,
    eval_jobs_enabled: true,
    eval_user: '<登录用户>',
  },
  installCommands: [
    {
      title: '登记终端（按提示粘贴接入码后回车；接入码不会出现在命令行历史里）',
      command:
        'sudo python3 <kit 目录>/tools/platform-collector.py --state <状态目录> enroll --kit <kit 目录> --server https://jiandun.example.com:8453 --tls-config <tls-deployment.json 路径> --token-stdin',
    },
    {
      title: '查看采集与传输状态（不显示凭据）',
      command: 'sudo python3 <kit 目录>/tools/platform-collector.py --state <状态目录> status',
    },
  ],
  oneclick: {
    available: true,
    reasons: [],
    scriptUrl: 'https://lse.example.com/api/fleet/install/linux.sh',
    scriptSha256: 'f'.repeat(64),
    scriptFile: '/tmp/jiandun-probe.sh',
    targets: [
      {
        target: 'linux-amd64',
        os: 'linux',
        arch: 'amd64',
        version: 'a'.repeat(40),
        filename: 'linux-amd64.tar.gz',
        bytes: 80573100,
        status: 'ok',
        oneclick: true,
      },
      {
        target: 'windows-amd64',
        os: 'windows',
        arch: 'amd64',
        version: 'a'.repeat(40),
        filename: 'windows-amd64.zip',
        bytes: 23883791,
        status: 'not_supported',
        oneclick: false,
        installer: { available: true },
      },
      {
        target: 'windows-arm64',
        os: 'windows',
        arch: 'arm64',
        version: 'a'.repeat(40),
        filename: 'windows-arm64.zip',
        bytes: 22100230,
        status: 'not_supported',
        oneclick: false,
        installer: { available: true },
      },
    ],
  },
};

/** 部署就绪，但探针包里没有 Windows 安装包文件：两个架构的安装包都不可用。 */
export const MOCK_INSTALLER_MISSING_REASON = '探针包目录缺少 Windows 安装包文件';
export const MOCK_DEPLOYMENT_NO_INSTALLER: FleetDeploymentInfo = {
  ...MOCK_DEPLOYMENT_READY,
  oneclick: {
    ...MOCK_DEPLOYMENT_READY.oneclick!,
    targets: MOCK_DEPLOYMENT_READY.oneclick!.targets.map((t) =>
      t.os === 'windows'
        ? { ...t, installer: { available: false, reason: MOCK_INSTALLER_MISSING_REASON } }
        : t,
    ),
  },
};

export const MOCK_DEPLOYMENT_NOT_READY: FleetDeploymentInfo = {
  ready: false,
  issues: ['未配置 FLEET_TLS_CERT_PEM_PATH（挂载的自签叶子证书 PEM 文件）'],
  warnings: [],
  server: 'https://127.0.0.1:29444',
  certificate: null,
  tlsDeployment: null,
  collectorConfigPatch: {},
  installCommands: [],
  oneclick: {
    available: false,
    reasons: ['部署信息尚未就绪（服务端地址或证书未配置完整）'],
    scriptUrl: null,
    scriptSha256: null,
    scriptFile: '/tmp/jiandun-probe.sh',
    targets: [],
  },
};
