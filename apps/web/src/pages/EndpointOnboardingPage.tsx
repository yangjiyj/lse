import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Copy, ExternalLink, RefreshCw } from 'lucide-react';
import { api, type EndpointInfo, type ModelTarget } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { FLEET_PATH, LIVE_EVAL_HOW_TO_ENABLE, formatInstalledAgents } from '@/lib/fleet';
import { PRODUCT_NAME } from '@/lib/product-name';
import { formatDateTime } from '@/lib/format';
import {
  isEndpointOnline,
  osLabel,
  productLabel,
  supportsLiveEval,
  suggestedEndpointTargetName,
} from '@/lib/endpoint-agents';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { SectionCard } from '@/components/page-kit/SectionCard';
import { NoteBox } from '@/components/page-kit/NoteBox';
import { SegmentTabs } from '@/components/page-kit/SegmentTabs';

type OsTab = 'linux' | 'windows' | 'macos';

/** 复制文本：优先用剪贴板接口，非安全上下文（http）下退回到临时文本框。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 退回到旧方式 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

function CommandBlock({ label, command }: { label: string; command: string }) {
  const toast = useToast();
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold text-ink">{label}</span>
        <Button
          size="sm"
          variant="outline"
          aria-label={`复制命令：${label}`}
          onClick={async () => {
            if (await copyText(command)) toast.success('命令已复制');
            else toast.error('复制失败，请手动选中命令复制');
          }}
        >
          <Copy className="h-3.5 w-3.5" />
          复制
        </Button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-xl border border-line bg-[#F7F9FD] px-4 py-3 font-mono text-[12.5px] leading-6 text-ink-2">
        {command}
      </pre>
    </div>
  );
}

function SubTitle({ children }: { children: string }) {
  return <h3 className="text-[14px] font-semibold text-ink">{children}</h3>;
}

export function buildInstallCommands(
  server: string,
  os: OsTab,
): Array<{ label: string; command: string }> {
  const serverArg = server || '<智能体安全平台地址>';
  const http = server.toLowerCase().startsWith('http://');
  if (os === 'linux') {
    return [
      {
        label: '安装（以 root 执行）',
        command: `sudo ./tools/install-enterprise-linux.sh install --kit "$PWD" --manifest-sha256 <受信manifest散列> --server '${serverArg}' --token-file /root/接入码文件${http ? ' --allow-http' : ''}`,
      },
      { label: '检查状态', command: 'sudo ./tools/install-enterprise-linux.sh status' },
    ];
  }
  if (os === 'windows') {
    return [
      {
        label: '安装（以管理员或 SYSTEM 身份，在 PowerShell 中执行）',
        command: `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\\enterprise-install.ps1 -Action install -KitRoot . -ManifestSha256 <受信manifest散列> -Server '${serverArg}' -EnrollmentCodeFile 'C:\\secure\\one-time-code.txt'${http ? ' -AllowHttp' : ''}`,
      },
      {
        label: '检查状态',
        command:
          'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\\enterprise-install.ps1 -Action status',
      },
    ];
  }
  return [
    {
      label: '安装（以 root 执行）',
      command: `sudo python3 tools/install-enterprise-macos.py install --kit "$PWD" --manifest-sha256 <受信manifest散列> --server '${serverArg}' --token-file <接入码文件路径>${http ? ' --allow-http' : ''}`,
    },
    { label: '检查状态', command: 'sudo python3 tools/install-enterprise-macos.py status' },
  ];
}

const OS_NOTES: Record<OsTab, string[]> = {
  linux: [
    '适用于使用 systemd 的 Linux 终端，需 root 权限；安装包自带运行环境，无需另装 Python。',
    '接入码写入 root 拥有、权限为 0600 的单行文件（路径交给 --token-file），不要写进命令参数；安装完成后清理该文件。',
    '安装后会创建开机自启的系统服务 agent-platform-collector。',
  ],
  windows: [
    '适用于 Windows x64 / ARM64，需以本机管理员或 SYSTEM 身份执行；安装包自带运行环境。',
    '接入码写入仅 SYSTEM / 管理员可读的 UTF-8 单行文件，路径由 -EnrollmentCodeFile 指定；安装器读取后会删除该文件。',
    '安装后会创建开机自启的 Windows 服务 AgentPlatformCollector。',
  ],
  macos: [
    'macOS 安装器随 macOS 安装包提供，需 root 权限，以系统服务（LaunchDaemon）方式运行；安装包不带 Python 运行环境，需终端已有 Python 3.8 及以上版本。',
    '智能体安全平台目前没有单独的 macOS 企业部署说明文档，上面的命令参数与安装器一致，但请先向智能体安全平台管理员确认安装包与受信散列；没有 macOS 安装包时，请联系管理员获取。',
  ],
};

export function EndpointOnboardingPage() {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const [osTab, setOsTab] = useState<OsTab>('linux');
  const canCreate = hasPermission('model_target:create');
  const canList = canCreate || hasPermission('eval_task:create');

  const config = useQuery({
    queryKey: ['endpoint-evals-config'],
    queryFn: () => api.endpointEvals.config(),
    retry: false,
  });
  const endpoints = useQuery({
    queryKey: ['endpoint-evals-endpoints', 'all'],
    queryFn: () => api.endpointEvals.endpoints(),
    enabled: canList && config.data?.enabled === true,
    retry: false,
  });
  const targets = useQuery({
    queryKey: ['model-targets', 'endpoint-registered'],
    queryFn: () => api.modelTargets.list({ page: 1, pageSize: 100 }),
    enabled: canList && config.data?.enabled === true && hasPermission('model_target:read'),
    retry: false,
  });

  // 自管终端接入是否启用：接口不存在或报错一律视为未启用，不影响本页其他内容。
  const fleetConfig = useQuery({
    queryKey: ['fleet', 'config'],
    queryFn: () => api.fleet.config(),
    retry: false,
  });
  const fleetEnabled = fleetConfig.data?.enabled === true;

  const baseUrl = (config.data?.agentshieldBaseUrl ?? '').trim();
  const enabled = config.data?.enabled === true;
  const registered = new Set(
    (targets.data?.items ?? [])
      .filter((t: ModelTarget) => t.targetType === 'ENDPOINT_AGENT' && t.isActive)
      .map((t: ModelTarget) => `${t.accessConfig?.endpointId}|${t.accessConfig?.product}`),
  );

  const register = (endpoint: EndpointInfo, product: string) =>
    navigate('/model-targets', {
      state: {
        registerEndpoint: {
          endpointId: endpoint.endpoint_id,
          hostname: endpoint.hostname,
          product,
          name: suggestedEndpointTargetName(endpoint.hostname, product),
        },
      },
    });

  return (
    <div className="space-y-5">
      <PageHeader
        title="接入终端智能体"
        description="终端智能体的配置体检和真机测评，复用智能体安全平台已接入的终端探针；终端已接入的，直接登记即可，无需重复安装。"
        actions={
          <Button variant="outline" onClick={() => navigate('/model-targets')}>
            返回评估对象
          </Button>
        }
      />

      {fleetEnabled && (
        <NoteBox tone="info" data-testid="fleet-hint">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              没有智能体安全平台？可用{PRODUCT_NAME}自管终端接入，终端直接向{PRODUCT_NAME}
              注册，在「终端」页即可完成接入码、安装包（Windows）或一键命令（Linux）。
            </span>
            <Button size="sm" variant="outline" onClick={() => navigate(FLEET_PATH)}>
              前往自管终端
            </Button>
          </div>
        </NoteBox>
      )}

      {config.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner className="h-5 w-5" />
        </div>
      ) : config.isError || !enabled ? (
        <NoteBox tone="warning" role="alert">
          终端智能体测评尚未启用，或读取配置失败。请联系平台管理员开启后再接入终端。
        </NoteBox>
      ) : (
        <>
          <SectionCard
            title="已接入的终端（可直接复用）"
            description="这些终端已由智能体安全平台接入，可直接登记为评估对象。"
            extra={
              canList && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void endpoints.refetch()}
                  disabled={endpoints.isFetching}
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${endpoints.isFetching ? 'animate-spin' : ''}`}
                  />
                  刷新
                </Button>
              )
            }
          >
            {!canList ? (
              <NoteBox>当前账号没有查看终端列表的权限，请联系管理员授权后查看。</NoteBox>
            ) : endpoints.isLoading ? (
              <div className="flex justify-center py-8">
                <Spinner className="h-5 w-5" />
              </div>
            ) : endpoints.isError ? (
              <NoteBox tone="warning" role="alert">
                <p>
                  终端列表加载失败：智能体安全平台地址未配置，或平台暂时无法访问。请联系部署管理员确认部署配置。
                </p>
                <Button
                  className="mt-2"
                  size="sm"
                  variant="outline"
                  onClick={() => void endpoints.refetch()}
                >
                  重试
                </Button>
              </NoteBox>
            ) : (endpoints.data ?? []).length === 0 ? (
              <EmptyState
                title="尚未发现已接入的终端"
                description="如果终端上已经装了智能体安全平台的探针，请先在智能体安全平台确认它在线；如果是新终端，请展开下方「新终端：安装探针」。"
              />
            ) : (
              <EndpointTable
                endpoints={endpoints.data ?? []}
                registered={registered}
                canRegister={canCreate}
                onRegister={register}
              />
            )}
            {(endpoints.data ?? []).some((e) => !e.eval_runner_version) && (
              <p className="mt-3 text-[13px] leading-6 text-ink-3" data-testid="no-runner-hint">
                列表中「无测评执行器」的终端目前只能做配置体检。{LIVE_EVAL_HOW_TO_ENABLE}
              </p>
            )}
            {(endpoints.data ?? []).length > 0 && (
              <p className="mt-3 text-[13px] leading-6 text-ink-3">
                点「登记为评估对象」会打开新建评估对象表单并预填终端信息，确认后保存，即可在「新建评估」里选择该终端发起配置体检或真机测评。
                {!canCreate && '（当前账号没有新建评估对象的权限，仅可查看说明。）'}
              </p>
            )}
          </SectionCard>

          <SectionCard title="先了解：终端探针是什么">
            <div className="space-y-2 text-[13.5px] leading-7 text-ink-2">
              <p>
                终端探针就是<strong>智能体安全平台</strong>的终端采集器，{PRODUCT_NAME}与它
                <strong>共用同一个采集器、复用其终端接入，不需要另装一套</strong>
                。终端如果已被智能体安全平台接入，会直接出现在上方列表里，登记为评估对象即可。
              </p>
              <p>
                「配置体检」读取终端上真实的智能体配置并判定；「真机测评」会在终端的隔离工作区里运行真实智能体，评估其工具调用行为。
              </p>
              <NoteBox tone="warning">
                风险提示：真机测评会在终端的隔离工作区里运行真实智能体，下发后由终端自动领取并执行；配置体检只读取配置，不运行智能体。
              </NoteBox>
            </div>
          </SectionCard>

          <SectionCard
            title={
              <span className="flex items-center gap-2">
                新终端：安装探针（仅当终端未接入时需要）
                <Badge tone="neutral">通常不需要</Badge>
              </span>
            }
          >
            <details className="group" data-testid="install-probe-fold">
              <summary className="cursor-pointer text-[13.5px] font-semibold text-primary">
                展开安装步骤
              </summary>
              <div className="mt-4 space-y-6">
                <section className="space-y-2">
                  <SubTitle>A. 在智能体安全平台创建接入码</SubTitle>
                  <p className="text-[13px] text-ink-3">
                    接入码由智能体安全平台的管理员在「终端接入」中创建
                  </p>
                  <div className="space-y-3 text-[13.5px] leading-7 text-ink-2">
                    {baseUrl ? (
                      <p>
                        智能体安全平台地址：
                        <code className="rounded bg-[#F7F9FD] px-1.5 py-0.5 font-mono text-[12.5px]">
                          {baseUrl}
                        </code>
                      </p>
                    ) : (
                      <NoteBox tone="warning" role="alert">
                        智能体安全平台地址未配置，请联系部署管理员在部署配置中设置。
                      </NoteBox>
                    )}
                    <ul className="list-disc space-y-1 pl-5">
                      <li>登录智能体安全平台，进入「终端接入」创建接入码。</li>
                      <li>接入码默认 24 小时有效，可设置本批设备数量上限。</li>
                      <li>接入码是敏感凭据：不要发到聊天里，也不要写进命令行参数。</li>
                    </ul>
                    {baseUrl && (
                      <Button
                        variant="outline"
                        onClick={() => window.open(baseUrl, '_blank', 'noopener,noreferrer')}
                      >
                        <ExternalLink className="h-4 w-4" />
                        打开智能体安全平台
                      </Button>
                    )}
                  </div>
                </section>
                <section className="space-y-2">
                  <SubTitle>B. 在终端安装探针</SubTitle>
                  <p className="text-[13px] text-ink-3">
                    在需要接入的员工电脑上执行；已安装过采集器的终端可跳过
                  </p>
                  <div className="space-y-4">
                    <SegmentTabs
                      ariaLabel="终端操作系统"
                      value={osTab}
                      onChange={setOsTab}
                      items={[
                        { value: 'linux', label: 'Linux' },
                        { value: 'windows', label: 'Windows' },
                        { value: 'macos', label: 'macOS' },
                      ]}
                    />
                    <ul className="list-disc space-y-1 pl-5 text-[13.5px] leading-7 text-ink-2">
                      {OS_NOTES[osTab].map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                    {buildInstallCommands(baseUrl, osTab).map((item) => (
                      <CommandBlock key={item.label} label={item.label} command={item.command} />
                    ))}
                    <NoteBox tone="info">
                      <p>
                        命令中带尖括号的内容需要替换：<strong>&lt;受信manifest散列&gt;</strong>
                        必须来自智能体安全平台的<strong>受信交付目录</strong>
                        （随安装包一起独立交付），请不要对待安装的包自行计算后直接信任；安装包本身的
                        SHA-256 也应先对照受信交付目录校验，再解压。
                      </p>
                      <p className="mt-1">
                        终端需要能向上面的平台地址发起出站连接，无需开放入站端口。
                        {baseUrl.toLowerCase().startsWith('http://') &&
                          '当前平台地址为 HTTP，命令已追加允许 HTTP 的参数，仅限受控内网使用。'}
                      </p>
                    </NoteBox>
                  </div>
                </section>
              </div>
            </details>
          </SectionCard>

          <SectionCard title="常见问题">
            <div className="space-y-2 text-[13.5px] leading-7 text-ink-2">
              <details className="rounded-xl border border-line px-4 py-2">
                <summary className="cursor-pointer font-semibold text-ink">
                  终端显示离线怎么办？
                </summary>
                <p className="mt-2">
                  最近上线时间超过 24
                  小时会标为「离线」。请确认终端已开机、采集器服务在运行（用「新终端：安装探针」里的「检查状态」命令），并且能访问智能体安全平台地址。
                </p>
              </details>
              <details className="rounded-xl border border-line px-4 py-2">
                <summary className="cursor-pointer font-semibold text-ink">
                  为什么终端不支持真机测评？
                </summary>
                <p className="mt-2">
                  真机测评要求终端装有测评执行器，且对应智能体支持无界面运行。不满足时只能做配置体检。
                  {LIVE_EVAL_HOW_TO_ENABLE}
                  装好后回到本页点刷新查看。Windows
                  终端没有系统级沙箱，真机测评只依靠终端钩子拦截危险操作，报告中会如实标注。
                </p>
              </details>
              <details className="rounded-xl border border-line px-4 py-2">
                <summary className="cursor-pointer font-semibold text-ink">需要什么权限？</summary>
                <p className="mt-2">
                  终端上安装需要 root /
                  管理员权限；在本平台登记评估对象需要「新建评估对象」权限，发起评估需要「新建评估任务」权限；具备这两项权限的管理员可以直接发起真机测评。
                </p>
              </details>
              <details className="rounded-xl border border-line px-4 py-2">
                <summary className="cursor-pointer font-semibold text-ink">
                  会采集终端上的哪些内容？
                </summary>
                <p className="mt-2">
                  依据智能体安全平台的隐私与安全边界：系统提示词和 CLAUDE.md
                  的内容不采集；环境变量只报键名和值的哈希；私钥和 .env
                  的内容绝不采集；工作目录和历史会话不采集原文；用户提示与模型回复默认只报哈希和长度。
                </p>
              </details>
            </div>
          </SectionCard>
        </>
      )}
    </div>
  );
}

function EndpointTable({
  endpoints,
  registered,
  canRegister,
  onRegister,
}: {
  endpoints: EndpointInfo[];
  registered: Set<string>;
  canRegister: boolean;
  onRegister: (endpoint: EndpointInfo, product: string) => void;
}) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>主机名</TH>
          <TH>系统</TH>
          <TH>所属人 / 部门</TH>
          <TH>已装智能体</TH>
          <TH>最近上线</TH>
          <TH>真机测评</TH>
          <TH>操作</TH>
        </TR>
      </THead>
      <TBody>
        {endpoints.map((e) => {
          const online = isEndpointOnline(e);
          return (
            <TR key={e.endpoint_id}>
              <TD data-label="主机名" className="font-medium">
                {e.hostname}
              </TD>
              <TD data-label="系统">{osLabel(e.os)}</TD>
              <TD data-label="所属人 / 部门">
                {[e.owner_display, e.department].filter(Boolean).join(' / ') || '—'}
              </TD>
              <TD data-label="已装智能体">
                {e.agents.length === 0
                  ? '—'
                  : formatInstalledAgents(
                      e.agents.map((a) => ({ name: a.product, version: a.version ?? null })),
                    ).join('、')}
              </TD>
              <TD data-label="最近上线">
                <span className="mr-2">{formatDateTime(e.last_seen_at)}</span>
                <Badge tone={online ? 'success' : 'neutral'}>{online ? '在线' : '离线'}</Badge>
              </TD>
              <TD data-label="真机测评">
                {e.agents.length === 0 ? (
                  '—'
                ) : (
                  <div className="space-y-0.5">
                    {e.agents.map((a) => (
                      <div key={a.product} className="text-[13px]">
                        {productLabel(a.product)}：
                        {supportsLiveEval(e, a.product) ? (
                          <span className="text-severity-pass">
                            支持（执行器 v{e.eval_runner_version}）
                          </span>
                        ) : (
                          <span className="text-ink-3" title={LIVE_EVAL_HOW_TO_ENABLE}>
                            {e.eval_runner_version ? '该智能体不支持无界面运行' : '无测评执行器'}
                            ，仅可体检
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </TD>
              <TD data-label="操作">
                <div className="flex flex-wrap gap-1.5">
                  {e.agents.map((a) =>
                    registered.has(`${e.endpoint_id}|${a.product}`) ? (
                      <Badge key={a.product} tone="info">
                        {productLabel(a.product)} 已登记
                      </Badge>
                    ) : (
                      canRegister && (
                        <Button
                          key={a.product}
                          size="sm"
                          variant="outline"
                          aria-label={`登记为评估对象：${e.hostname} ${productLabel(a.product)}`}
                          onClick={() => onRegister(e, a.product)}
                        >
                          登记为评估对象（{productLabel(a.product)}）
                        </Button>
                      )
                    ),
                  )}
                </div>
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}
