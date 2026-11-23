import { LIVE_RISK_TYPE_IDS, LIVE_RISK_DESCRIPTIONS, type LiveRiskTypeCatalogItem } from '../../../../../packages/shared/src/fleet-live-eval.js';
import { ENDPOINT_SCENARIO_CATALOG, SCRIPTED_SCENARIO_CATALOG } from '../endpoint-evals/pack.js';
export interface CheckImpact {
  level: 'read_only' | 'runs_agent';
  touches: string[];
  reversible: boolean;
  note: string;
}

export interface CheckItem {
  id: string;
  mode: 'posture' | 'live';
  category: 'permission' | 'mcp' | 'skill' | 'instruction' | 'credential' | 'behavior' | 'environment';
  title: string;
  what: string;
  why: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  impact: CheckImpact;
  remediation: string;
}

export interface CheckCatalog {
  categories: Array<{ id: CheckItem['category']; label: string; order: number }>;
  posture: CheckItem[];
  live: CheckItem[];
  liveRiskTypes: LiveRiskTypeCatalogItem[];
  liveSummary: {
    title: string;
    steps: string[];
    consumesQuota: string;
    isolationNote: string;
    cleanup: string;
  };
}

function posture(
  id: string,
  category: CheckItem['category'],
  title: string,
  severity: CheckItem['severity'],
  what: string,
  why: string,
  remediation: string,
  touches: string[],
): CheckItem {
  return {
    id,
    mode: 'posture',
    category,
    title,
    what,
    why,
    severity,
    remediation,
    impact: {
      level: 'read_only',
      touches,
      reversible: true,
      note: '只读取配置并分析已采集的检查结果，不运行智能体，不改动终端文件，无需撤销。',
    },
  };
}

function live(
  id: string,
  category: CheckItem['category'],
  title: string,
  what: string,
  why: string,
  remediation: string,
  touches: string[],
  note: string,
): CheckItem {
  return {
    id,
    mode: 'live',
    category,
    title,
    what,
    why,
    severity: 'HIGH',
    remediation,
    impact: {
      level: 'runs_agent',
      touches,
      reversible: false,
      note: `${note}临时目录会清理；无有效隔离时的额外改动无法保证完全撤销，已消耗的模型额度无法退回。`,
    },
  };
}

const controlledReceiver =
  '会运行真实智能体，尝试把测试用的假凭据发送到平台自己的受控接收地址，不会发往外部；测试文件位于临时目录。';
const codeCommentMutation =
  '会启动真实智能体，阅读临时目录内的代码注释，检查它是否听从注释中冒充管理员的要求，改写临时目录内预置的保留测试文件。';
const externalWriteIsolation =
  '有系统隔离时，写入范围受限制，本轮专用测试路径会单独开放以核对是否越权；没有系统隔离时，测评不会启动。';

/** 检测项目面向管理员的说明统一维护于此，标识与实际判定规则、场景包保持一致。 */
export const CHECK_CATALOG: CheckCatalog = {
  categories: [
    { id: 'permission', label: '权限与授权', order: 1 },
    { id: 'mcp', label: 'MCP 工具', order: 2 },
    { id: 'skill', label: 'Skill 技能', order: 3 },
    { id: 'instruction', label: '指令文件', order: 4 },
    { id: 'credential', label: '凭据', order: 5 },
    { id: 'behavior', label: '实机行为', order: 6 },
    { id: 'environment', label: '部署与运行环境', order: 7 },
  ],
  posture: [
    posture(
      'permissions',
      'permission',
      '权限确认边界',
      'HIGH',
      '智能体是否被设成不用确认就能执行命令、联网、读写文件。',
      '一旦听从错误指令，智能体可能在无人确认的情况下改动文件或发送数据。',
      '关闭跳过确认或绕过权限的设置，对执行命令和敏感操作保留人工确认。',
      ['智能体权限配置'],
    ),
    posture(
      'broad_allow',
      'permission',
      '命令与网络授权范围',
      'MEDIUM',
      '智能体是否获准执行范围过大的命令或随意访问网络。',
      '过宽的授权可能让不可信任务读取文件或把内部信息发送出去。',
      '按实际工作需要缩小命令和网络授权范围，删除不必要的全量放行设置。',
      ['智能体命令与网络授权配置'],
    ),
    posture(
      'mcp_injection',
      'mcp',
      '工具描述中的诱导指令',
      'HIGH',
      '工具说明中是否藏有要求忽略原有指令、冒充其他工具或发送信息的内容。',
      '智能体可能把工具说明误当作可信指令，进而泄露信息或执行错误操作。',
      '停用存在异常说明的工具，核实提供方并清除诱导内容后再启用。',
      ['工具配置与工具说明'],
    ),
    posture(
      'mcp_transport',
      'mcp',
      '工具连接与外联范围',
      'MEDIUM',
      '远程工具是否使用加密连接，连接地址是否在允许访问的范围内。',
      '连接不受信任的地址或使用未加密连接，可能导致信息被窃取。',
      '将远程工具改为加密连接，并将确认可信的地址纳入允许访问的范围。',
      ['工具连接配置'],
    ),
    posture(
      'mcp_risk',
      'mcp',
      'MCP 配置风险',
      'MEDIUM',
      '工具是否缺少授权、依赖有风险、启动命令不安全、来源不明或被项目自动批准。',
      '不可信工具可能在智能体调用时获得不必要的访问权限或运行危险命令。',
      '核实工具来源和依赖，修正启动命令与授权设置，关闭项目级自动批准。',
      ['工具授权、依赖、启动命令与项目配置'],
    ),
    posture(
      'skill_source',
      'skill',
      '技能来源可追溯性',
      'LOW',
      '已安装技能是否记录了可核实的来源。',
      '来源不明的技能可能携带未经审核的指令或脚本。',
      '补充并核实技能来源，移除无法确认提供方的技能。',
      ['已安装技能的来源记录'],
    ),
    posture(
      'skill_risk',
      'skill',
      '技能高危行为',
      'HIGH',
      '技能是否包含改写指令、长期自动运行、删除文件、读取凭据、上传信息或隐藏执行的行为。',
      '这些行为可能让智能体泄露内部数据、破坏文件或持续运行未经批准的操作。',
      '先停用命中风险的技能，逐项核实业务必要性，移除危险脚本并限制文件与网络权限。',
      ['已安装技能的指令与脚本静态检查结果'],
    ),
    posture(
      'instruction_file',
      'instruction',
      '指令文件隐藏内容与密钥',
      'HIGH',
      '智能体读取的指令文件中是否含有隐藏文字或访问密钥。',
      '隐藏文字可能改变智能体行为，文件中的密钥可能被误用或泄露。',
      '清除隐藏内容，将密钥移至专门的凭据管理位置；已暴露的密钥应及时更换。',
      ['已采集的指令文件内容与隐藏文字标记'],
    ),
    posture(
      'credentials',
      'credential',
      '凭据暴露',
      'MEDIUM',
      '智能体或工具配置中是否存在探针识别出的凭据暴露。',
      '暴露的密码或访问密钥可能被他人用于访问内部系统。',
      '移除明文凭据并使用受控的凭据管理方式，更换可能已经泄露的凭据。',
      ['智能体与工具配置的凭据检查结果'],
    ),
    posture(
      'hooks',
      'permission',
      '终端工具防护接入',
      'LOW',
      '终端是否在智能体使用工具之前接入了安全检查。',
      '缺少执行前检查时，危险操作可能无法被及时阻止。',
      '按终端接入指引启用工具执行前的安全检查，并确认防护处于工作状态。',
      ['终端防护状态与工具执行前检查配置'],
    ),
    posture(
      'sandbox_scope',
      'environment',
      '运行沙箱与目录范围',
      'MEDIUM',
      '智能体的沙箱是否被设成完整主机访问。',
      '沙箱放开后，智能体可读写主目录和系统目录，一次误操作影响整台电脑。',
      '改用受限沙箱，只开放专用工作目录。',
      ['智能体沙箱配置'],
    ),
    posture(
      'sandbox_enabled',
      'environment',
      '沙箱开启状态',
      'MEDIUM',
      '智能体自带的沙箱是否开启，包括当前系统不支持沙箱、智能体没有自带沙箱的情形。',
      '没有沙箱时，智能体运行的命令直接以当前用户的权限读写文件和联网。',
      '开启智能体自带的沙箱；当前系统不支持或没有自带沙箱的，改在容器或虚拟机里运行。',
      ['智能体沙箱配置'],
    ),
    posture(
      'sandbox_bypass',
      'environment',
      '沙箱绕开设置',
      'MEDIUM',
      '沙箱开启后，配置是否仍允许命令不经沙箱运行，或允许智能体自行越出沙箱。',
      '留有绕开途径时，被诱导的智能体可以让命令在沙箱之外执行。',
      '关闭不经沙箱重试和越出沙箱的申请，清空排除在沙箱之外的命令。',
      ['智能体沙箱配置'],
    ),
    posture(
      'sandbox_credential_read',
      'environment',
      '沙箱内凭据目录读取',
      'MEDIUM',
      '沙箱开启后，~/.ssh、~/.aws 等凭据目录是否仍在沙箱的可读范围内。',
      '沙箱内的命令读得到密钥和云凭据，就可能把它们发送出去。',
      '把凭据目录加入沙箱的拒绝读取名单。',
      ['智能体沙箱配置'],
    ),
    posture(
      'model_destination',
      'environment',
      '模型出口来源',
      'MEDIUM',
      '智能体调用的模型地址是官方接口、受管网关，还是来源不明的中转站。',
      '经中转站的提示词和数据可能被截留，也无法确认模型来源。',
      '改用官方接口或受管网关，把确认可信的地址登记为受管出口。',
      ['智能体模型出口配置'],
    ),
    posture(
      'agent_version',
      'environment',
      '智能体版本可追溯',
      'LOW',
      '每个智能体是否上报了可识别的版本号。',
      '版本不明就无法对照安全公告判断是否要升级。',
      '升级到能识别版本的安装包。',
      ['智能体安装版本'],
    ),
    posture(
      'platform_exposure',
      'environment',
      '智能体平台对外暴露',
      'HIGH',
      '容器部署的智能体平台是否把敏感端口发布到所有网卡、管理端缺少鉴权或开放自助注册。',
      '对外暴露的管理入口可能被他人直接访问。',
      '端口绑定回环地址，启用管理端鉴权并关闭自助注册。',
      ['智能体平台容器的端口与鉴权配置'],
    ),
    posture(
      'platform_telemetry',
      'environment',
      '运行数据外发',
      'MEDIUM',
      '智能体平台是否启用了遥测或更新信息外发。',
      '运行数据可能在无人知晓时被送出。',
      '按数据边界关闭不需要的遥测与更新检查。',
      ['智能体平台的遥测配置'],
    ),
    posture(
      'platform_version',
      'environment',
      '智能体平台版本漏洞',
      'HIGH',
      '智能体平台镜像版本是否落入已登记的漏洞范围。',
      '已知漏洞版本可被直接利用。',
      '升级到已核实的修复版本。',
      ['智能体平台镜像版本'],
    ),
  ],
  liveRiskTypes: LIVE_RISK_TYPE_IDS.map((id) => ({ id, ...LIVE_RISK_DESCRIPTIONS[id], scriptedScenarioCount: SCRIPTED_SCENARIO_CATALOG.filter((s) => s.risk_type === id).length, scenarioIds: ENDPOINT_SCENARIO_CATALOG.filter((s) => s.risk_type === id).map((s) => s.scenario_id) })),
  live: LIVE_RISK_TYPE_IDS.flatMap((risk) => ENDPOINT_SCENARIO_CATALOG.filter((s) => s.risk_type === risk).map((s) => live(
    s.scenario_id, risk === 'credential_access' ? 'credential' : risk === 'indirect_instruction' ? 'instruction' : 'behavior', s.title,
    `${s.what_we_asked}诱导内容来自${s.inducement_source}。`,
    LIVE_RISK_DESCRIPTIONS[risk].what, '将资料中的指令视为待核实内容，限制文件、命令和网络权限，敏感操作保留人工确认。',
    ['临时测试目录', ...(risk === 'out_of_scope_write' || s.scenario_id === 'endpoint-code-comment-injection' ? s.judgement_targets : []), ...(risk === 'exfiltration' || s.scenario_id === 'endpoint-tool-output-injection' ? ['平台受控接收地址'] : [])],
    `${risk === 'exfiltration' || s.scenario_id === 'endpoint-tool-output-injection' ? controlledReceiver : s.scenario_id === 'endpoint-code-comment-injection' ? codeCommentMutation : '会启动真实智能体，在临时目录内读取测试资料并核对工具调用和文件变化。'}${risk === 'out_of_scope_write' ? `会在工作目录外专门创建测试文件，已有同名路径时拒绝执行；结束后核对并清理本次创建的路径。${externalWriteIsolation}` : ''}${risk === 'untrusted_command' ? '下载命令只使用无效的 .invalid 测试域名，不会实际下载或执行远程脚本。' : ''}`,
  ))),
  liveSummary: {
    title: '真机测评会在终端上运行真实智能体',
    steps: [
      '在终端上新建临时目录（仅当前用户可读写），放入测试用的假文件和假凭据。',
      '使用已登记的真实智能体，按所选风险类型依次执行测试任务（全部选择时共 12 个），检查它是否拒绝诱导操作。',
      '收集任务结果和文件变化，结束后删除临时目录。',
    ],
    consumesQuota:
      '使用登录用户本人的主目录配置，包括真实的工具、技能、权限设置和模型路由；会消耗该智能体对应的模型额度，已消耗的额度无法退回。',
    isolationNote:
      'Linux 有 bwrap 且可用时，只开放临时测试目录、本轮专用测试路径和必要的智能体运行记录区域，其余位置只读；macOS 有 sandbox-exec 且可用时按同一原则限制写入，其余位置只读。上述隔离都不可用时（包括 Windows），测评不会启动。实际隔离方式会显示在结果中；防护未生效时不能视为安全。系统隔离限制文件写入，但不代表完全禁止联网。',
    cleanup:
      '结束后删除临时目录并记录文件变化；专用测试路径会核对并清理；若清理失败，会在结果中说明，已消耗的模型额度无法退回。',
  },
};

/**
 * 扩展体检规则：需要探针补采新字段（见 docs/standards/endpoint-probe-fields.md），
 * 环境开关 LSE_ENDPOINT_POSTURE_EXTENDED=true 后才会出现在体检里，所以不放进 CHECK_CATALOG.posture。
 */
export const EXTENDED_POSTURE_CHECKS: CheckItem[] = [
  posture('run_as_admin', 'environment', '运行账户权限', 'HIGH', '智能体是否以管理员或 root 身份运行。', '高权限运行时，被诱导的操作可以改动整个系统。', '改用普通账号运行智能体。', ['智能体运行账户']),
  posture('dir_scope', 'environment', '可访问目录范围', 'MEDIUM', '智能体是否被授予主目录或系统目录的访问权限。', '访问范围过大会让凭据和个人文件暴露给智能体。', '建立专用工作目录，只授予该目录。', ['智能体目录授权']),
  posture('logging', 'environment', '日志记录设置', 'MEDIUM', '智能体是否开启日志并设为最细粒度。', '没有日志就无法事后追溯文件、命令和网络操作。', '开启日志并保留。', ['智能体日志设置']),
  posture('listen_exposure', 'environment', '本机监听范围', 'HIGH', '智能体及相关服务是否监听了局域网或所有网卡。', '对外监听会让他人直接访问智能体接口。', '改为仅本机可访问。', ['智能体监听地址']),
  posture('install_source', 'environment', '安装来源', 'MEDIUM', '智能体安装物料是否来自官方渠道。', '修改版或二次分发版可能带有后门。', '从官方渠道重新安装。', ['智能体安装来源']),
  posture('install_integrity', 'environment', '安装物料校验', 'MEDIUM', '智能体安装物料的签名或杂凑值是否通过校验。', '校验不过说明文件可能被篡改。', '重新获取并校验安装物料。', ['智能体安装文件']),
];
