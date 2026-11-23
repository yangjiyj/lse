import { INJECTION_RE } from '../gateway-logs/agent-analysis.js';
import { endpointPostureClauses } from '../reports/compliance-mapping.js';
import { clauseCitation, getClause } from '@lse/shared';

type RecordValue = Record<string, unknown>;
const record = (v: unknown): RecordValue =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as RecordValue) : {};
const list = (v: unknown): RecordValue[] => (Array.isArray(v) ? v.map(record) : []);
const text = (v: unknown) => (typeof v === 'string' ? v : '');
const secretPattern =
  /\bsk-[a-zA-Z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:API_KEY|SECRET|PASSWORD)\s*[:=]\s*[^\s*\[]+/i;
export type PostureState = 'risk' | 'review' | 'clear' | 'not_checked';
export interface PostureSubject {
  kind: 'agent' | 'mcp' | 'skill' | 'instruction_file' | 'scheduled_agent';
  name: string;
  state: PostureState;
  detail: string;
  subjectKey?: string;
  /** 仅 state=not_checked：没检查的成因键（见 shared/not-checked 词表）。 */
  cause?: string;
  /** 智能体安装所在的账号与位置，用于区分同一产品的多处安装。 */
  where?: string;
  rule_id?: string;
  reason_zh?: string;
  file_label?: string;
  line_number?: number | null;
  context_type?: string;
  hits?: Array<Record<string, unknown>>;
}
export interface PostureFinding {
  state: PostureState;
  notCheckedReason?: string;
  howToCheck?: string;
  subjects: PostureSubject[];
  plainTitle: string;
  plainWhy: string;
  plainFix: string;
  ruleId: string;
  title: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  verdict: 'PASS' | 'FAIL' | 'UNKNOWN';
  riskCategory: string;
  evidence: string;
  compliance: readonly string[];
}
/** 扩展规则开关：探针补采新字段后才有数据，默认关闭。LSE_ENDPOINT_POSTURE_EXTENDED=true 开启。 */
export function extendedPostureEnabled(): boolean {
  return process.env.LSE_ENDPOINT_POSTURE_EXTENDED === 'true';
}
export interface JudgePostureOptions {
  /** 是否启用扩展规则；缺省读环境开关。 */
  extended?: boolean;
}
const SAFE_DESTINATIONS = new Set(['official', 'gateway', 'local', 'internal']);
export function judgePosture(
  posture: RecordValue,
  allowedHosts: string[] = [],
  options: JudgePostureOptions = {},
): PostureFinding[] {
  const permissions = record(posture.permissions);
  // AgentShield lse_eval_posture.go 当前确实采集的字段；其余空数组是占位。
  // 待服务端提供 collected_fields 后优先使用元数据，避免把未采集误当作安全。
  const collected = new Set(
    Array.isArray(posture.collected_fields)
      ? posture.collected_fields.filter((v): v is string => typeof v === 'string')
      : posture.collected_at === null
        ? []
        : [
            'permissions.mode',
            'mcp_servers',
            'mcp_servers.transport',
            'mcp_servers.command_or_url',
            'mcp_servers.env_keys',
            'skills',
            'skills.source',
            'instruction_files.path',
            'instruction_files.sha256',
          ],
  );
  const knownList = (field: string, value: unknown) =>
    Array.isArray(value) && (value.length > 0 || collected.has(field));
  const servers = list(posture.mcp_servers);
  const skills = list(posture.skills);
  const files = list(posture.instruction_files);
  const destinations = list(posture.model_destinations);
  const versions = list(posture.agent_versions);
  const platformChecks = list(posture.platform_checks);
  const sandbox = record(posture.sandbox);
  const platformKnown = posture.platform_scanned === true;
  const platformHit = (...rules: string[]) =>
    platformChecks.some((c) => rules.includes(text(c.rule_id)) && text(c.status) === 'finding');
  const flag = (key: string) => (typeof posture[key] === 'boolean' ? (posture[key] as boolean) : undefined);
  const rules: Array<[string, string, PostureFinding['severity'], string, boolean, boolean]> = [
    [
      'permissions',
      '权限确认边界',
      'HIGH',
      'agent_tool_abuse',
      typeof permissions.mode === 'string' && typeof permissions.skip_confirm === 'boolean',
      /bypass/i.test(text(permissions.mode)) || permissions.skip_confirm === true,
    ],
    [
      'broad_allow',
      '命令与网络授权范围',
      'MEDIUM',
      'agent_tool_abuse',
      knownList('permissions.allow', permissions.allow),
      (Array.isArray(permissions.allow) ? permissions.allow : []).some((v) =>
        /Bash\(\s*\*\s*\)|\b(curl|wget|nc|ssh|scp)\b|WebFetch\(\*\)/i.test(text(v)),
      ),
    ],
    [
      'mcp_injection',
      '工具描述注入',
      'HIGH',
      'prompt_injection',
      knownList('mcp_servers', posture.mcp_servers) &&
        (servers.length > 0 ||
          Array.isArray(posture.collected_fields) ||
          collected.has('mcp_servers.tool_descriptions')) &&
        servers.every((s) => knownList('mcp_servers.tool_descriptions', s.tool_descriptions)),
      list(posture.mcp_servers).some((s) =>
        list(s.tool_descriptions).some(
          (t) =>
            INJECTION_RE.test(text(t.description)) ||
            /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(text(t.description)),
        ),
      ),
    ],
    [
      'mcp_transport',
      '工具传输与外联白名单',
      'MEDIUM',
      'ssrf_network_access',
      knownList('mcp_servers', posture.mcp_servers) &&
        servers.every(
          (s) =>
            typeof s.transport === 'string' &&
            (s.transport === 'stdio' || typeof s.command_or_url === 'string'),
        ),
      list(posture.mcp_servers).some((s) => {
        if (!['http', 'sse', 'streamable-http'].includes(text(s.transport))) return false;
        if (s.command_or_url == null) return false;
        try {
          const url = new URL(text(s.command_or_url));
          return url.protocol !== 'https:' || !allowedHosts.includes(url.hostname);
        } catch {
          return true;
        }
      }),
    ],
    [
      'skill_source',
      '技能来源可追溯性',
      'LOW',
      'agent_tool_abuse',
      knownList('skills', posture.skills) && skills.every((s) => typeof s.source === 'string'),
      list(posture.skills).some(
        (s) =>
          typeof s.source === 'string' && (!s.source.trim() || /^(unknown|未知)$/i.test(s.source)),
      ),
    ],
    [
      'skill_risk',
      '技能高危行为',
      'HIGH',
      'skill',
      knownList('skill_risks', posture.skill_risks) ||
        (!Object.hasOwn(posture, 'skill_risks') &&
          knownList('skills', posture.skills) &&
          skills.length === 0),
      list(posture.skill_risks).length > 0,
    ],
    [
      'mcp_risk',
      'MCP 配置风险',
      'MEDIUM',
      'mcp',
      knownList('mcp_risks', posture.mcp_risks) ||
        (!Object.hasOwn(posture, 'mcp_risks') &&
          knownList('mcp_servers', posture.mcp_servers) &&
          servers.length === 0),
      list(posture.mcp_risks).length > 0,
    ],
    [
      'instruction_file',
      '指令文件隐藏内容与密钥',
      'HIGH',
      'prompt_injection',
      knownList('instruction_files', posture.instruction_files) &&
        files.every(
          (f) =>
            typeof f.excerpt === 'string' &&
            knownList('instruction_files.hidden_text_flags', f.hidden_text_flags),
        ),
      list(posture.instruction_files).some(
        (f) =>
          (Array.isArray(f.hidden_text_flags) && f.hidden_text_flags.length > 0) ||
          secretPattern.test(text(f.excerpt)),
      ),
    ],
    [
      'credentials',
      '凭据暴露',
      'MEDIUM',
      'privacy_leakage',
      knownList('credentials_exposure', posture.credentials_exposure),
      list(posture.credentials_exposure).length > 0,
    ],
    [
      'hooks',
      '终端工具防护接入',
      'LOW',
      'agent_tool_abuse',
      typeof posture.managed_by_agentshield === 'boolean' || knownList('hooks', posture.hooks),
      posture.managed_by_agentshield === false ||
        (knownList('hooks', posture.hooks) &&
          !list(posture.hooks).some(
            (h) =>
              h.event === 'PreToolUse' && /agentshield|hookd|agent.platform/i.test(text(h.command)),
          )),
    ],
    [
      'sandbox_scope',
      '运行沙箱与目录范围',
      'MEDIUM',
      'agent_tool_abuse',
      typeof sandbox.full_access === 'boolean',
      sandbox.full_access === true,
    ],
    [
      'sandbox_enabled',
      '沙箱开启状态',
      'MEDIUM',
      'agent_tool_abuse',
      typeof sandbox.off === 'boolean',
      sandbox.off === true,
    ],
    [
      'sandbox_bypass',
      '沙箱绕开设置',
      'MEDIUM',
      'agent_tool_abuse',
      typeof sandbox.bypass_allowed === 'boolean',
      sandbox.bypass_allowed === true,
    ],
    [
      'sandbox_credential_read',
      '沙箱内凭据目录读取',
      'MEDIUM',
      'privacy_leakage',
      typeof sandbox.credential_readable === 'boolean',
      sandbox.credential_readable === true,
    ],
    [
      'model_destination',
      '模型出口来源',
      'MEDIUM',
      'privacy_leakage',
      destinations.length > 0 &&
        destinations.every(
          (d) =>
            text(d.approval_status) === 'not_listed' ||
            text(d.classification) === 'relay' ||
            SAFE_DESTINATIONS.has(text(d.classification)),
        ),
      destinations.some(
        (d) => text(d.classification) === 'relay' || text(d.approval_status) === 'not_listed',
      ),
    ],
    [
      'agent_version',
      '智能体版本可追溯',
      'LOW',
      'agent_tool_abuse',
      versions.length > 0,
      versions.some((v) => !text(v.version) || text(v.version) === 'version_unknown'),
    ],
    [
      'platform_exposure',
      '智能体平台对外暴露',
      'HIGH',
      'ssrf_network_access',
      platformKnown,
      platformHit('platform.exposure', 'platform.admin_auth', 'platform.signup'),
    ],
    [
      'platform_telemetry',
      '运行数据外发',
      'MEDIUM',
      'privacy_leakage',
      platformKnown,
      platformHit('platform.telemetry'),
    ],
    [
      'platform_version',
      '智能体平台版本漏洞',
      'HIGH',
      'agent_tool_abuse',
      platformKnown,
      platformHit('platform.version'),
    ],
    ...((options.extended ?? extendedPostureEnabled())
      ? ([
          ['run_as_admin', '运行账户权限', 'HIGH', 'agent_tool_abuse', flag('run_as_admin') !== undefined, flag('run_as_admin') === true],
          ['dir_scope', '可访问目录范围', 'MEDIUM', 'agent_tool_abuse', flag('dir_scope_broad') !== undefined, flag('dir_scope_broad') === true],
          ['logging', '日志记录设置', 'MEDIUM', 'agent_tool_abuse', flag('logging_ok') !== undefined, flag('logging_ok') === false],
          ['listen_exposure', '本机监听范围', 'HIGH', 'ssrf_network_access', flag('listen_public') !== undefined, flag('listen_public') === true],
          ['install_source', '安装来源', 'MEDIUM', 'agent_tool_abuse', flag('install_untrusted') !== undefined, flag('install_untrusted') === true],
          ['install_integrity', '安装物料校验', 'MEDIUM', 'agent_tool_abuse', flag('integrity_failed') !== undefined, flag('integrity_failed') === true],
        ] as Array<[string, string, PostureFinding['severity'], string, boolean, boolean]>)
      : []),
  ];
  return rules.map(([ruleId, title, severity, riskCategory, known, hit]) =>
    completeFinding({
      ruleId,
      title,
      severity,
      riskCategory,
      verdict: hit ? 'FAIL' : known ? 'PASS' : 'UNKNOWN',
      evidence: `${
        ['skill_risk', 'mcp_risk'].includes(ruleId) && hit
          ? list(posture[ruleId === 'skill_risk' ? 'skill_risks' : 'mcp_risks'])
              .map((r) => text(r.behavior))
              .join('；') + '。'
          : ''
      }${hit ? `终端采集配置命中「${title}」规则，需整改复核。` : known ? '本次采集配置未命中该风险规则。' : '终端未上报该项，无法判定。'}`,
      compliance: endpointPostureClauses(ruleId),
    }),
  );
}

/** 所有判定入口统一补齐三态、管理员说明与供报告直接展示的国标对照。 */
export function completeFinding(
  finding: Omit<PostureFinding, 'state' | 'subjects' | 'plainTitle' | 'plainWhy' | 'plainFix'> &
    Partial<PostureFinding>,
): PostureFinding {
  const state: PostureState =
    finding.verdict === 'FAIL'
      ? 'risk'
      : finding.verdict === 'PASS'
        ? 'clear'
        : finding.state === 'review'
          ? 'review'
          : 'not_checked';
  const compliance = finding.compliance.filter((id) => getClause(id));
  const complianceSuffix = complianceSuffixText(compliance);
  // 探针汇总会再次补齐并附加采集范围说明，先移除旧后缀（含已废弃的「①②④」写法）再统一放到末尾。
  const base = stripComplianceSuffix(finding.evidence, complianceSuffix);
  const evidence = complianceSuffix ? base + complianceSuffix : base;
  return {
    ...finding,
    compliance,
    evidence,
    state,
    subjects: finding.subjects ?? [],
    plainTitle: finding.plainTitle ?? finding.title,
    plainWhy: finding.plainWhy ?? '检查智能体及其工具的配置，避免未经确认的操作影响文件和数据。',
    plainFix: finding.plainFix ?? '请终端管理员核对对应配置，保留必要的人工确认并重新检测。',
    ...(state === 'not_checked'
      ? {
          notCheckedReason: finding.notCheckedReason ?? '终端没有提供完成这一项检查所需的信息。',
          howToCheck:
            finding.howToCheck ??
            '请终端管理员更新探针，确认对应配置可读取后重新检测；仍缺失时联系平台管理员。',
        }
      : { notCheckedReason: undefined, howToCheck: undefined }),
  };
}

/** 证据末尾的条款对照，例如「 对照：TC260-PG-20266A 附录 A 部署阶段 · 正文 8 c)「不使用操作系统管理员权限运行智能体…」。」 */
export function complianceSuffixText(clauseIds: readonly string[]): string {
  const parts = clauseIds
    .map((id) => getClause(id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .map((c) => `${clauseCitation(c)}「${c.title}」`);
  return parts.length ? ` 对照：${parts.join('；')}。` : '';
}

/**
 * 去掉证据里的条款对照：本条的对照后缀（原样匹配，可能被采集范围说明挤到中间）
 * 与已废弃的「 GB/T 45654 智能体检测项：…（候选对照）。」。
 */
export function stripComplianceSuffix(evidence: string, suffix = ''): string {
  const legacyRemoved = evidence.replace(/\s?GB\/T 45654 智能体检测项：[^（]*（候选对照）。?/g, '');
  return suffix ? legacyRemoved.split(suffix).join('') : legacyRemoved;
}
