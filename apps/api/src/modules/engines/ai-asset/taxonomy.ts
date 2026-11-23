import type { AiAssetType, TaxonomyReference, RiskDomain } from '@lse/shared';
import { complianceClausesForDomain } from '../../reports/compliance-mapping.js';

export type AiRuleSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface AiAssetRuleDefinition {
  ruleId: string;
  riskCategory: RiskDomain;
  /** 中文标题 */
  title: string;
  /** 中文说明：这条规则检测什么、为什么危险 */
  description: string;
  severity: AiRuleSeverity;
  /** 规则默认置信度（按规则精确度给出，个别命中可在引擎中上调/下调） */
  confidence: number;
  remediation: string;
  /** 与 AIG Skill（T01-T09）/ MCP（MCP01-05）编号的映射 */
  aig: Array<{ framework: 'AIG_SKILL' | 'AIG_MCP'; id: string }>;
}

const SKILL = 'AIG_SKILL' as const;
const MCP = 'AIG_MCP' as const;

const DEFS: AiAssetRuleDefinition[] = [
  {
    ruleId: 'mcp.tool_poisoning',
    riskCategory: 'prompt_injection',
    title: '工具描述/技能说明中存在投毒指令',
    description:
      '工具描述、参数描述或 SKILL.md 中出现面向模型的隐藏指令（如 <IMPORTANT> 标签、“调用本工具前先调用…”、“不要告诉用户”、“忽略之前的指令”），模型会把这些文本当作指令执行，可被用来窃取数据或劫持智能体行为。',
    severity: 'HIGH',
    confidence: 0.85,
    remediation:
      '删除描述中所有面向模型的操作性指令，描述只陈述工具功能与参数含义；上架前人工审核工具描述，并对描述变更做审批。',
    aig: [
      { framework: MCP, id: 'MCP03' },
      { framework: SKILL, id: 'T01' },
    ],
  },
  {
    ruleId: 'mcp.hidden_unicode',
    riskCategory: 'prompt_injection',
    title: '文本中含有不可见字符或 Unicode 标签字符',
    description:
      '检测到零宽字符、Unicode Tag（U+E0000–U+E007F）或双向控制符。这些字符在界面上不可见但会被模型读取，常用于隐藏投毒指令或伪装代码。',
    severity: 'HIGH',
    confidence: 0.9,
    remediation: '移除全部不可见字符；在发布流水线中加入不可见字符检查，拒绝包含 Unicode Tag 与双向控制符的描述和源码。',
    aig: [
      { framework: MCP, id: 'MCP03' },
      { framework: SKILL, id: 'T01' },
    ],
  },
  {
    ruleId: 'mcp.sensitive_path_instruction',
    riskCategory: 'data_exfiltration',
    title: '描述文本指示模型读取敏感文件',
    description:
      '面向模型的文本要求读取 ~/.ssh、~/.aws/credentials、.env、~/.cursor/mcp.json 等凭据文件，属于典型的凭据窃取型工具投毒。',
    severity: 'CRITICAL',
    confidence: 0.92,
    remediation: '立即下架该组件并排查已安装环境；轮换可能泄露的密钥；描述中不得出现任何读取本地凭据文件的要求。',
    aig: [
      { framework: MCP, id: 'MCP03' },
      { framework: SKILL, id: 'T09' },
    ],
  },
  {
    ruleId: 'mcp.encoded_payload',
    riskCategory: 'prompt_injection',
    title: '描述文本中隐藏编码载荷',
    description: '面向模型的文本中包含可解码为指令的 Base64 片段，常用于绕过人工审核隐藏投毒内容。',
    severity: 'HIGH',
    confidence: 0.8,
    remediation: '删除描述中的编码片段；描述应为明文可审阅内容。',
    aig: [{ framework: MCP, id: 'MCP03' }],
  },
  {
    ruleId: 'mcp.rug_pull',
    riskCategory: 'prompt_injection',
    title: '工具描述与历史基线不一致（疑似 Rug Pull）',
    description:
      '同一资产再次扫描时，工具描述的哈希与首次记录的基线不同。已获用户信任的工具在不通知的情况下修改描述，是 Rug Pull 攻击的典型特征。',
    severity: 'HIGH',
    confidence: 0.75,
    remediation: '核对描述变更来源与内容；对工具描述做版本锁定，描述变化时要求重新审批后才能继续使用。',
    aig: [{ framework: MCP, id: 'MCP03' }],
  },
  {
    ruleId: 'mcp.tool_shadowing',
    riskCategory: 'agent_tool_abuse',
    title: '与其他已登记服务存在同名工具（工具遮蔽）',
    description:
      '当前资产声明的工具名与平台已扫描过的其他 MCP 服务的工具同名但描述不同，智能体可能调用到错误的实现，恶意服务可借此劫持可信工具。',
    severity: 'MEDIUM',
    confidence: 0.7,
    remediation: '为工具名加服务前缀，客户端按服务限定工具调用；确认同名工具的来源可信。',
    aig: [{ framework: MCP, id: 'MCP03' }],
  },
  {
    ruleId: 'code.command_execution',
    riskCategory: 'agent_tool_abuse',
    title: '代码通过 Shell 执行系统命令',
    description:
      '检测到 subprocess(shell=True)、os.system、os.popen、child_process.exec/execSync、spawn(shell:true) 等经由 Shell 执行命令的调用；命令串若拼接了外部输入即构成命令注入。',
    severity: 'HIGH',
    confidence: 0.8,
    remediation: '改用参数数组方式调用（shell=False / execFile），对命令做白名单；以低权限账户和受限工作目录运行。',
    aig: [
      { framework: MCP, id: 'MCP05' },
      { framework: SKILL, id: 'T04' },
    ],
  },
  {
    ruleId: 'code.command_injection',
    riskCategory: 'output_injection',
    title: '命令串拼接外部输入（命令注入）',
    description: '经由 Shell 执行的命令串使用了字符串拼接、f-string、format 或模板字符串，外部可控参数可注入任意命令。',
    severity: 'CRITICAL',
    confidence: 0.85,
    remediation: '禁止拼接命令串；改为参数数组调用并对参数做严格校验（白名单/正则），必要时使用 shlex.quote。',
    aig: [
      { framework: MCP, id: 'MCP05' },
      { framework: SKILL, id: 'T04' },
    ],
  },
  {
    ruleId: 'code.remote_code_execution',
    riskCategory: 'output_injection',
    title: '下载远程脚本并直接执行',
    description: '检测到 curl/wget/Invoke-WebRequest 的输出直接管道给 sh/bash/python/iex 执行，远程内容被篡改即可在本机执行任意代码。',
    severity: 'CRITICAL',
    confidence: 0.9,
    remediation: '移除远程脚本直接执行；依赖通过包管理器固定版本安装，并校验制品哈希。',
    aig: [
      { framework: SKILL, id: 'T03' },
      { framework: MCP, id: 'MCP05' },
    ],
  },
  {
    ruleId: 'code.dynamic_execution',
    riskCategory: 'output_injection',
    title: '动态执行代码',
    description: '检测到 eval/exec/new Function/vm.runIn* 等动态执行调用，传入的内容若可被外部影响即可执行任意代码。',
    severity: 'HIGH',
    confidence: 0.75,
    remediation: '移除动态执行；需要解析数据时使用 json.loads / ast.literal_eval 等安全解析方式。',
    aig: [
      { framework: MCP, id: 'MCP05' },
      { framework: SKILL, id: 'T04' },
    ],
  },
  {
    ruleId: 'code.obfuscated_execution',
    riskCategory: 'output_injection',
    title: '混淆后执行代码',
    description:
      '检测到 exec(base64.b64decode(...))、__import__("os")、marshal.loads、codecs rot13 等混淆执行手法，正常组件几乎不会这样写，通常用于隐藏恶意逻辑。',
    severity: 'CRITICAL',
    confidence: 0.9,
    remediation: '拒绝使用该组件；要求供应方提供可审阅的明文源码。',
    aig: [
      { framework: SKILL, id: 'T03' },
      { framework: MCP, id: 'MCP05' },
    ],
  },
  {
    ruleId: 'code.data_exfiltration',
    riskCategory: 'data_exfiltration',
    title: '读取敏感数据并向外发送',
    description: '同一文件中既读取凭据文件/环境变量全集，又通过 requests/httpx/fetch/axios 等向外发送数据，存在凭据外传风险。',
    severity: 'CRITICAL',
    confidence: 0.85,
    remediation: '删除敏感数据读取与外发逻辑；出站地址做白名单并在网络层限制组件外联。',
    aig: [
      { framework: MCP, id: 'MCP01' },
      { framework: SKILL, id: 'T09' },
    ],
  },
  {
    ruleId: 'code.sensitive_file_access',
    riskCategory: 'privacy_leakage',
    title: '代码读取本地凭据文件',
    description: '代码直接读取 ~/.ssh、~/.aws/credentials、.env、/etc/shadow、浏览器 Cookie 等凭据文件。',
    severity: 'HIGH',
    confidence: 0.8,
    remediation: '组件不应读取宿主凭据；需要的凭据由平台以受控方式注入。',
    aig: [
      { framework: MCP, id: 'MCP01' },
      { framework: SKILL, id: 'T09' },
    ],
  },
  {
    ruleId: 'code.path_traversal',
    riskCategory: 'agent_tool_abuse',
    title: '文件路径由外部参数控制且未校验（路径穿越）',
    description: '工具参数直接用于打开/读写文件，且附近没有 realpath/resolve 等规范化与根目录校验，调用方可用 ../ 读写任意文件。',
    severity: 'HIGH',
    confidence: 0.7,
    remediation: '将路径规范化（realpath/path.resolve）后校验必须位于允许的根目录内，拒绝绝对路径与 ..。',
    aig: [{ framework: MCP, id: 'MCP02' }],
  },
  {
    ruleId: 'code.ssrf',
    riskCategory: 'ssrf_network_access',
    title: '服务端请求伪造（SSRF）风险',
    description: '代码访问云元数据地址（169.254.169.254 等），或把工具参数中的 URL 直接用于服务端请求且未做地址校验。',
    severity: 'HIGH',
    confidence: 0.75,
    remediation: '对出站 URL 做协议与域名白名单，拒绝内网、回环、链路本地与元数据地址，并禁止跟随重定向。',
    aig: [
      { framework: SKILL, id: 'T05' },
      { framework: MCP, id: 'MCP02' },
    ],
  },
  {
    ruleId: 'code.hardcoded_secret',
    riskCategory: 'privacy_leakage',
    title: '源码或配置中硬编码密钥',
    description: '检测到格式化凭据（AWS AccessKey、GitHub Token、OpenAI/Anthropic Key、Slack Token、私钥等）或高熵的密钥赋值。证据已脱敏。',
    severity: 'HIGH',
    confidence: 0.85,
    remediation: '立即吊销并轮换该凭据；改为运行时由密钥管理服务注入，不得提交到组件包中。',
    aig: [
      { framework: MCP, id: 'MCP01' },
      { framework: SKILL, id: 'T09' },
    ],
  },
  {
    ruleId: 'code.unauthenticated_listener',
    riskCategory: 'agent_tool_abuse',
    title: 'HTTP 服务监听 0.0.0.0 且未见鉴权',
    description: 'MCP/HTTP 服务绑定到所有网卡，但组件中没有任何鉴权逻辑（Authorization 校验、Token 验证、鉴权中间件），同网段任何人都可调用其工具。',
    severity: 'HIGH',
    confidence: 0.7,
    remediation: '默认只监听 127.0.0.1；对外提供时必须启用鉴权（Bearer Token / OAuth）并限制来源。',
    aig: [{ framework: MCP, id: 'MCP02' }],
  },
  {
    ruleId: 'manifest.overbroad_permission',
    riskCategory: 'agent_tool_abuse',
    title: '清单/配置声明了过大的权限',
    description: '组件清单或配置中的权限声明（permissions、allowed-tools、allowedDirectories、scopes 等）使用了通配或根目录等过大范围。',
    severity: 'HIGH',
    confidence: 0.8,
    remediation: '按最小权限声明具体的工具、目录与作用域；高危权限需单独审批。',
    aig: [{ framework: MCP, id: 'MCP02' }],
  },
  {
    ruleId: 'skill.instruction_mismatch',
    riskCategory: 'prompt_injection',
    title: '技能说明与实际实现能力不一致',
    description: 'SKILL.md 未声明，但实现代码具备命令执行、网络外发或凭据读取等能力，用户按说明授权时无法得知真实行为。',
    severity: 'MEDIUM',
    confidence: 0.6,
    remediation: '在 SKILL.md 中如实声明命令执行、网络访问与数据读取范围，或删除未声明的实现。',
    aig: [{ framework: SKILL, id: 'T01' }],
  },
  {
    ruleId: 'dep.known_vulnerability',
    riskCategory: 'component_vulnerability',
    title: '依赖组件存在已知漏洞',
    description: '依赖清单或锁文件中确定版本的组件命中离线漏洞库中的已知漏洞（CVE/GHSA）。',
    severity: 'HIGH',
    confidence: 0.9,
    remediation: '升级到漏洞库给出的修复版本，并在锁文件中固定版本。',
    aig: [],
  },
];

const RULES: Record<string, AiAssetRuleDefinition> = Object.fromEntries(
  DEFS.map((d) => [d.ruleId, d]),
);

/** 旧版规则 ID（历史数据）→ 新规则，保证旧发现项仍能取到中文标题。 */
const LEGACY_ALIASES: Record<string, string> = {
  'skill.remote_code_execution': 'code.remote_code_execution',
  'skill.command_execution': 'code.command_execution',
  'skill.secret_exposure': 'code.hardcoded_secret',
  'skill.metadata_access': 'code.ssrf',
  'mcp.command_injection': 'code.command_injection',
  'mcp.secret_exposure': 'code.hardcoded_secret',
  'mcp.overbroad_scope': 'manifest.overbroad_permission',
};

export function aiAssetRule(ruleId: string): AiAssetRuleDefinition | null {
  return RULES[ruleId] ?? RULES[LEGACY_ALIASES[ruleId] ?? ''] ?? null;
}

export function allAiAssetRules(): AiAssetRuleDefinition[] {
  return DEFS;
}

function addFrameworkRefs(
  refs: TaxonomyReference[],
  framework: string,
  ids: string[],
  mappingVersion = 'lse-2026-09',
): void {
  for (const id of ids) refs.push({ framework, id, mappingVersion });
}

export function taxonomyForAiAssetRule(ruleId: string): TaxonomyReference[] {
  const definition = aiAssetRule(ruleId);
  if (!definition) return [];
  const refs: TaxonomyReference[] = [];
  for (const item of definition.aig) addFrameworkRefs(refs, item.framework, [item.id]);
  const compliance = complianceClausesForDomain(definition.riskCategory);
  addFrameworkRefs(refs, 'GB/T45654', compliance.gbt45654);
  addFrameworkRefs(refs, 'OWASP_LLM_TOP10', compliance.owasp);
  addFrameworkRefs(refs, 'MITRE_ATLAS', compliance.atlas);
  addFrameworkRefs(refs, 'OWASP_AGENTIC', compliance.agentic);
  return refs;
}

export function assetTypeForRule(ruleId: string): AiAssetType {
  return ruleId.startsWith('mcp.') ? 'MCP_SERVER' : 'SKILL';
}
