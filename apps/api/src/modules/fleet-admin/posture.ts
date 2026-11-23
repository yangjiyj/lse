import {
  agentConfigItems,
  reportInventory,
  skillHitState,
  skillSource,
  legacyConfigValue,
  safeText,
} from './inventory.js';
import { agentInstallLocation, agentOwnerAccount } from './agent-snapshot.js';
import { fleetAgentIdentity } from '../../../../../packages/shared/src/fleet-agent-display.js';
import {
  agentConfigCauses,
  causeFromEvidenceCode,
  notCheckedCause,
  type NotCheckedCauseKey,
} from '../../../../../packages/shared/src/not-checked.js';
// 把 aiprobe.report.v1（自管终端体检上报）适配成 endpoint-evals/posture-judge 的判定输入，
// 配置判定复用 judgePosture；静态命中结合文件位置区分风险与待确认，
// 不用于“伪造”通过：未采集的字段保持 UNKNOWN。
import {
  judgePosture,
  completeFinding,
  extendedPostureEnabled,
  type PostureFinding,
  type PostureSubject,
} from '../endpoint-evals/posture-judge.js';

import { CHECK_CATALOG } from './check-catalog.js';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {};
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec) : []);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

const AGENT_KINDS = new Set(['cli_agent', 'ide_plugin', 'desktop_app']);
/**
 * 新增的逐安装规则：探针没上报时不逐个生成「没检查」对象（避免概览多出一批相同原因的行），
 * 只在规则层面记为未检；已取得结论的安装照常列出。
 */
const NEW_AGENT_RULES = ['sandbox_scope', 'model_destination', 'agent_version', 'run_as_admin', 'dir_scope', 'logging', 'listen_exposure', 'install_source', 'install_integrity'];
/** 逐个智能体安装给出结论的规则。 */
const AGENT_SUBJECT_RULES = [
  'permissions',
  'broad_allow',
  'credentials',
  'hooks',
  'sandbox_scope',
  'sandbox_enabled',
  'sandbox_bypass',
  'sandbox_credential_read',
  'model_destination',
  'agent_version',
  'run_as_admin',
  'dir_scope',
  'logging',
  'listen_exposure',
  'install_source',
  'install_integrity',
];
interface Check {
  rule_id: string;
  status: string;
  severity: string;
  reason_zh: string;
  evidence_code: string;
  file_label: string;
  line_number: number | null;
  context_type: string;
}
function checksOf(holder: Rec): Check[] {
  return arr(rec(holder.static_assessment).checks).map((c) => ({
    rule_id: str(c.rule_id),
    status: str(c.status),
    severity: str(c.severity),
    reason_zh: str(c.reason_zh),
    evidence_code: str(c.evidence_code),
    file_label: str(c.file_label),
    line_number: typeof c.line_number === 'number' ? c.line_number : null,
    context_type: str(c.context_type),
  }));
}

const SANDBOX_OPEN = /^(?:danger-full-access|full[-_ ]?access|none|off|disabled)$/i;
const SANDBOX_UNREAD = new Set(['', 'unknown', 'internal_store', 'read_failed']);

/** 三项沙箱检查读探针上报的 evidence.sandbox，判定规则与依据见 docs/endpoint-fleet/sandbox-posture-rules.md。 */
const SANDBOX_RULES = ['sandbox_enabled', 'sandbox_bypass', 'sandbox_credential_read'];
/** 已按官方文档核对过沙箱配置项的智能体；其余一律未检查。 */
const SANDBOX_AGENTS = new Set(['claude-code', 'codex', 'gemini', 'opencode', 'openclaw', 'hermes']);
const SANDBOX_OFF_REASONS = {
  off: '该智能体的沙箱没有开启。请在配置里开启沙箱。',
  platform_unsupported:
    '该智能体在当前系统上不支持自带沙箱，命令不经沙箱运行。请改在受支持的系统、容器或虚拟机里运行。',
  no_builtin: '该智能体没有自带沙箱，命令直接以当前用户的权限运行。请改在容器或虚拟机里运行。',
};
// 途径和目录只按固定词表转成说明，不回显探针给的其他文字。
const SANDBOX_BYPASS_WAYS: Record<string, string> = {
  allow_unsandboxed_commands: '命令失败后可以不经沙箱重试',
  excluded_commands: '有命令被排除在沙箱之外',
  approval_on_request: '智能体可以申请越出沙箱运行',
  elevated_exec: '开启了越出沙箱的提权执行',
};
const SANDBOX_CREDENTIAL_DIRS = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.azure',
  '.config/gcloud',
]);
interface SandboxVerdict {
  state: 'risk' | 'clear' | 'not_checked';
  detail?: string;
  cause?: NotCheckedCauseKey;
}
const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;

function sandboxVerdict(asset: Rec, rule: string): SandboxVerdict {
  const raw = rec(asset.evidence).sandbox;
  if (!SANDBOX_AGENTS.has(str(asset.name)))
    return { state: 'not_checked', cause: 'sandbox_unverifiable' };
  if (raw === undefined) return { state: 'not_checked', cause: 'sandbox_not_reported' };
  const facts = rec(raw);
  const unread = rec(facts.unread);
  const unknown = (field: string): SandboxVerdict => ({
    state: 'not_checked',
    cause: str(unread[field]) === 'config_read_failed' ? 'config_read_failed' : 'sandbox_unverifiable',
  });
  const support = str(facts.support);
  const off =
    support === 'platform_unsupported' || support === 'no_builtin'
      ? support
      : support === 'supported' && typeof facts.enabled === 'boolean'
        ? facts.enabled
          ? undefined
          : ('off' as const)
        : null;
  if (off === null) return unknown('enabled');
  if (rule === 'sandbox_enabled')
    return off ? { state: 'risk', detail: SANDBOX_OFF_REASONS[off] } : { state: 'clear' };
  if (off) return { state: 'not_checked', cause: 'sandbox_not_enabled' };
  if (rule === 'sandbox_bypass') {
    if (typeof facts.unsandboxed_allowed !== 'boolean') return unknown('unsandboxed');
    if (!facts.unsandboxed_allowed) return { state: 'clear' };
    const ways = (strings(facts.unsandboxed_via) ?? [])
      .filter((code) => Object.hasOwn(SANDBOX_BYPASS_WAYS, code))
      .map((code) => SANDBOX_BYPASS_WAYS[code]!);
    return {
      state: 'risk',
      detail: `该智能体的配置允许命令不经沙箱运行${ways.length ? `：${[...new Set(ways)].join('、')}` : ''}。请关闭这些设置。`,
    };
  }
  const credentialDirs = rec(facts.credential_dirs);
  const readable = strings(credentialDirs.readable);
  if (!readable || !strings(credentialDirs.checked)) return unknown('credential_dirs');
  if (!readable.length) return { state: 'clear' };
  const dirs = [...new Set(readable)].filter((dir) => SANDBOX_CREDENTIAL_DIRS.has(dir));
  return {
    state: 'risk',
    detail: `沙箱内可以读取${dirs.length ? ` ${dirs.map((dir) => `~/${dir}`).join('、')}` : '凭据目录'}。请把这些目录加入沙箱的拒绝读取名单。`,
  };
}
/** 某一项沙箱检查在一处安装上的结论：有风险为 true，已检查无风险为 false，没检查为 undefined。 */
function sandboxHit(asset: Rec, rule: string): boolean | undefined {
  const { state } = sandboxVerdict(asset, rule);
  return state === 'not_checked' ? undefined : state === 'risk';
}

/** 每个智能体安装上，探针已上报但此前没被体检用上的事实；undefined 表示没取得。 */
interface AgentFacts {
  sandboxOpen?: boolean;
  sandboxOff?: boolean;
  sandboxBypass?: boolean;
  sandboxCredentialRead?: boolean;
  destinations: Rec[];
  name: string;
  version: string;
  // 以下为扩展字段（需探针补采，默认不读取）
  runAsAdmin?: boolean;
  dirScopeBroad?: boolean;
  loggingOk?: boolean;
  listenPublic?: boolean;
  installUntrusted?: boolean;
  integrityFailed?: boolean;
}

function sandboxOpenOf(asset: Rec): boolean | undefined {
  const evidence = rec(asset.evidence);
  const checks = checksOf(evidence).filter((c) => c.rule_id === 'config.sandbox');
  if (checks.some((c) => c.status === 'finding')) return true;
  const mode = str(rec(evidence.config).sandbox_mode);
  if (!mode.startsWith('default:') && !SANDBOX_UNREAD.has(mode)) return SANDBOX_OPEN.test(mode);
  if (checks.length && checks.every((c) => c.status === 'pass')) return false;
  return undefined;
}

function destinationsOf(asset: Rec): Rec[] {
  const evidence = rec(asset.evidence);
  const raw = [...(evidence.endpoint ? [rec(evidence.endpoint)] : []), ...arr(evidence.destinations)];
  return raw
    .filter((d) => str(d.classification) || str(d.approval_status))
    .map((d) => ({
      classification: str(d.classification),
      approval_status: str(d.approval_status),
      provider: safeText(d.provider, 40),
    }));
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function agentFacts(asset: Rec, extended: boolean): AgentFacts {
  const evidence = rec(asset.evidence);
  const runtime = rec(evidence.runtime);
  const facts: AgentFacts = {
    sandboxOpen: sandboxOpenOf(asset),
    sandboxOff: sandboxHit(asset, 'sandbox_enabled'),
    sandboxBypass: sandboxHit(asset, 'sandbox_bypass'),
    sandboxCredentialRead: sandboxHit(asset, 'sandbox_credential_read'),
    destinations: destinationsOf(asset),
    name: str(asset.name),
    version: str(asset.version),
  };
  const modelExit = checksOf(evidence).filter((c) => c.rule_id === 'model.exit' || c.rule_id === 'proxy.route');
  if (modelExit.some((c) => c.status === 'finding'))
    facts.destinations.push({ classification: 'unknown', approval_status: 'not_listed', provider: '' });
  if (!extended) return facts;
  facts.runAsAdmin = bool(runtime.run_as_admin);
  const dirs = Array.isArray(runtime.accessible_dirs) ? runtime.accessible_dirs.map(str) : undefined;
  if (dirs) facts.dirScopeBroad = dirs.some((d) => ['home', 'system', 'root'].includes(d));
  const logging = rec(rec(evidence.config).logging);
  if (typeof logging.enabled === 'boolean') facts.loggingOk = logging.enabled && logging.finest_level === true;
  if (Array.isArray(runtime.listeners))
    facts.listenPublic = arr(runtime.listeners).some((l) => ['any', 'lan'].includes(str(l.scope)));
  const source = str(evidence.install_source);
  if (source && source !== 'unknown') facts.installUntrusted = ['modified', 'third_party'].includes(source);
  const integrity = rec(evidence.integrity);
  if (typeof integrity.signature_verified === 'boolean' || typeof integrity.hash_matches === 'boolean')
    facts.integrityFailed = integrity.signature_verified === false || integrity.hash_matches === false;
  return facts;
}

/** 多个对象的同一个布尔事实合并：任何一个命中即命中；全部取得且都没命中才算没命中；否则未知。 */
function mergeFlag(values: Array<boolean | undefined>, hit: boolean): boolean | undefined {
  if (values.some((v) => v === hit)) return hit;
  return values.length > 0 && values.every((v) => v !== undefined) ? !hit : undefined;
}

/** 把若干智能体安装的事实合成 judgePosture 的输入片段。 */
function factsToInput(list: AgentFacts[]): Rec {
  const out: Rec = {};
  const sandbox: Rec = {};
  for (const [key, values] of [
    ['full_access', list.map((f) => f.sandboxOpen)],
    ['off', list.map((f) => f.sandboxOff)],
    ['bypass_allowed', list.map((f) => f.sandboxBypass)],
    ['credential_readable', list.map((f) => f.sandboxCredentialRead)],
  ] as Array<[string, Array<boolean | undefined>]>) {
    const merged = mergeFlag(values, true);
    if (merged !== undefined) sandbox[key] = merged;
  }
  if (Object.keys(sandbox).length) out.sandbox = sandbox;
  const destinations = list.flatMap((f) => f.destinations);
  if (destinations.length) out.model_destinations = destinations;
  if (list.length) out.agent_versions = list.map((f) => ({ name: f.name, version: f.version }));
  const flags: Array<[string, Array<boolean | undefined>, boolean]> = [
    ['run_as_admin', list.map((f) => f.runAsAdmin), true],
    ['dir_scope_broad', list.map((f) => f.dirScopeBroad), true],
    ['logging_ok', list.map((f) => f.loggingOk), false],
    ['listen_public', list.map((f) => f.listenPublic), true],
    ['install_untrusted', list.map((f) => f.installUntrusted), true],
    ['integrity_failed', list.map((f) => f.integrityFailed), true],
  ];
  for (const [key, values, hit] of flags) {
    const merged = mergeFlag(values, hit);
    if (merged !== undefined) out[key] = merged;
  }
  return out;
}

export interface ReportPostureInput {
  input: Rec;
  /** 规则 ID → 报告静态检查给出的命中原因（用于把对应判定置为 FAIL）。 */
  staticHits: Map<string, string[]>;
}

/** 规则映射：judgePosture 的 ruleId ← 报告 static_assessment 的 rule_id 前缀/精确值。 */
const STATIC_RULE_MAP: Array<[string, (ruleId: string) => boolean]> = [
  ['permissions', (r) => r === 'config.permission' || r === 'config.auto_approval'],
  ['mcp_injection', (r) => /^mcp\.description_(override|shadowing|exfil)$/.test(r)],
  ['mcp_transport', (r) => r === 'mcp.transport'],
  ['credentials', (r) => r === 'config.credential' || r === 'mcp.credential'],
];

// 只展示受控的行为说明，不回显探针提供的脚本、配置内容或凭据。
const SKILL_RISKS: Record<string, string> = {
  'skill.instruction_write': '会写入指令文件',
  'skill.persistence': '会设置长期自动运行',
  'skill.destructive_delete': '会删除文件或目录',
  'skill.credential_access': '会读取凭据',
  'skill.pipe_shell': '会下载内容并直接运行',
  'skill.instruction_override': '会要求忽略原有安全指令',
  'skill.script_patterns': '包含高风险脚本行为',
  'skill.network_upload': '会把内容上传到外部地址',
  'skill.encoded_execution': '会解码并运行隐藏内容',
};
const MCP_RISKS: Record<string, string> = {
  'mcp.authorization': '缺少访问授权',
  'mcp.dependency': '依赖组件存在风险',
  'mcp.launch': '启动命令存在风险',
  'mcp.source': '工具来源不明',
  'mcp.project_auto_approve': '项目配置会自动批准工具操作',
};

/**
 * 技能规则集 v2 只上报命中的规则，再加一条脚本汇总项：汇总项通过且证据码为
 * script_pattern_not_matched，说明受支持脚本都检查完了，其余各类行为没有命中就是没有。
 */
function scriptsFullyChecked(checks: Check[]): boolean {
  return checks.some(
    (c) =>
      c.rule_id === 'skill.script_patterns' &&
      c.status === 'pass' &&
      c.evidence_code === 'script_pattern_not_matched',
  );
}

function staticRiskSummary(
  holders: Rec[],
  meanings: Record<string, string>,
  complete: boolean,
  covered?: (checks: Check[]) => boolean,
) {
  const rules = Object.keys(meanings);
  const checks = holders.flatMap(checksOf);
  const hits = [
    ...new Set(
      checks
        .filter(
          (c) =>
            c.status === 'finding' &&
            rules.includes(c.rule_id) &&
            (!c.rule_id.startsWith('skill.') || skillHitState({ ...c }) === 'risk'),
        )
        .map((c) => meanings[c.rule_id]!),
    ),
  ];
  const known =
    (complete || holders.length > 0) &&
    holders.every((holder) => {
      const own = checksOf(holder);
      return (
        (covered?.(own) ||
          rules.every((rule) => own.some((c) => c.rule_id === rule && c.status === 'pass'))) &&
        own.filter((c) => rules.includes(c.rule_id)).every((c) => c.status === 'pass')
      );
    });
  return hits.length > 0 ? hits.map((behavior) => ({ behavior })) : known ? [] : undefined;
}

export function adaptProbeReport(report: unknown): ReportPostureInput {
  const body = rec(report);
  const assets = arr(body.assets);
  const evidenceOf = (a: Rec) => rec(a.evidence);

  const { mcp, skills, agents } = reportInventory(report);
  const configs = agents.map((a) => rec(evidenceOf(a).config));
  const mcpRaw = mcp;

  const allChecks = [
    ...assets.flatMap((a) => checksOf(evidenceOf(a))),
    ...mcp.flatMap(checksOf),
    ...skills.flatMap(checksOf),
  ];
  const agentChecks = agents.flatMap((a) => checksOf(evidenceOf(a)));

  const modes = configs.map((c) => legacyConfigValue(c.permission_mode));
  const autos = configs.map((c) => legacyConfigValue(c.auto_approval));
  const permissionFinding = agentChecks.some(
    (c) => c.rule_id === 'config.permission' && c.status === 'finding',
  );
  const mode = permissionFinding
    ? 'bypassPermissions'
    : (modes.find((m) => /bypass/i.test(m)) ??
      (agents.length > 0 && modes.every(Boolean) ? modes[0] : undefined));
  const autoKnown = agents.length > 0 && autos.every((v) => v && v !== 'unknown');
  const skipConfirm = autos.includes('enabled') ? true : autoKnown ? false : undefined;

  const credentialChecks = allChecks.filter(
    (c) => c.rule_id === 'config.credential' || c.rule_id === 'mcp.credential',
  );
  const credentialKnown =
    agents.length > 0 &&
    agents.every((a) =>
      checksOf(evidenceOf(a)).some(
        (c) => c.rule_id === 'config.credential' && c.status !== 'unknown',
      ),
    );
  const agentsCollector = arr(body.collectors).find((c) => str(c.name) === 'agents');
  const inventoryComplete = str(agentsCollector?.status) === 'complete';

  const collected: string[] = [];
  if (mode !== undefined) collected.push('permissions.mode');
  if (inventoryComplete || mcp.length) collected.push('mcp_servers', 'mcp_servers.transport');
  if (inventoryComplete || skills.length) collected.push('skills');
  if (inventoryComplete && mcp.every((m) => str(m.transport) === 'stdio' || str(m.origin)))
    collected.push('mcp_servers.command_or_url');
  if (credentialKnown) collected.push('credentials_exposure');
  const facts = factsToInput(agents.map((a) => agentFacts(a, extendedPostureEnabled())));
  const platformChecks = allChecks.filter((c) => c.rule_id.startsWith('platform.'));

  const riskHolders = (items: Rec[], meanings: Record<string, string>) => [
    ...items,
    ...assets.map(evidenceOf).filter((e) => checksOf(e).some((c) => c.rule_id in meanings)),
  ];
  const skillRisks = staticRiskSummary(
    riskHolders(skills, SKILL_RISKS),
    SKILL_RISKS,
    inventoryComplete,
    scriptsFullyChecked,
  );
  const mcpRiskItems = [
    ...mcpRaw,
    ...assets.filter((a) => str(a.kind) === 'mcp_server').map(evidenceOf),
  ];
  const mcpRisks = staticRiskSummary(
    riskHolders(mcpRiskItems, MCP_RISKS),
    MCP_RISKS,
    inventoryComplete,
  );
  if (skillRisks !== undefined) collected.push('skill_risks');
  if (mcpRisks !== undefined) collected.push('mcp_risks');

  const input: Rec = {
    collected_at: str(body.scanned_at) || null,
    collected_fields: collected,
    skill_risks: skillRisks,
    mcp_risks: mcpRisks,
    permissions: {
      ...(mode !== undefined ? { mode } : {}),
      ...(skipConfirm !== undefined ? { skip_confirm: skipConfirm } : {}),
    },
    mcp_servers:
      inventoryComplete || mcp.length > 0
        ? mcp.map((m) => ({
            name: str(m.name),
            transport: str(m.transport) || undefined,
            command_or_url: str(m.transport) === 'stdio' ? null : str(m.origin) || undefined,
          }))
        : undefined,
    skills:
      inventoryComplete || skills.length > 0
        ? skills.map((s) => ({
            name: str(s.name),
            installedIn: s.installedIn,
            ...(typeof s.source === 'string' ? { source: s.source } : {}),
          }))
        : undefined,
    credentials_exposure: credentialKnown
      ? credentialChecks.filter((c) => c.status === 'finding').map((c) => ({ rule: c.rule_id }))
      : undefined,
    ...facts,
    // 智能体平台类组件（容器部署的 Dify 等）：采集完成且没有平台检查，说明终端上没有这类组件。
    platform_checks: platformChecks.map((c) => ({ rule_id: c.rule_id, status: c.status })),
    platform_scanned: inventoryComplete || platformChecks.length > 0,
  };

  const staticHits = new Map<string, string[]>();
  for (const c of allChecks) {
    if (c.status !== 'finding') continue;
    for (const [ruleId, match] of STATIC_RULE_MAP)
      if (match(c.rule_id))
        staticHits.set(ruleId, [
          ...new Set([...(staticHits.get(ruleId) ?? []), c.reason_zh || c.rule_id]),
        ]);
  }
  return { input, staticHits };
}

/** 逐对象判定，局部采集失败不覆盖其他对象已完成的检查。 */
export function judgeProbeReport(report: unknown, allowedHosts: string[] = []): PostureFinding[] {
  const { input } = adaptProbeReport(report);
  const assets = arr(rec(report).assets);
  const scheduled = assets.filter((a) => a.kind === 'scheduled_agent');
  const { mcp: tools, skills, agents } = reportInventory(report);
  return judgePosture(input, allowedHosts).map((f) => {
    let subjects: PostureSubject[] = [];
    if (AGENT_SUBJECT_RULES.includes(f.ruleId)) {
      subjects = agents.map((a, index) => agentSubject(a, f.ruleId, index, 'agent', report));
      if (f.ruleId === 'permissions')
        subjects.push(
          ...scheduled.map((a, index) =>
            agentSubject(a, f.ruleId, index, 'scheduled_agent', report),
          ),
        );
      if (f.ruleId === 'credentials')
        subjects.push(
          ...tools
            .filter((m) => checksOf(m).some((c) => c.rule_id === 'mcp.credential'))
            .map((m) => checkSubject(m, 'mcp', 'mcp.credential', '凭据检查')),
        );
    } else if (f.ruleId === 'mcp_risk') {
      subjects = tools.flatMap((m) =>
        Object.entries(MCP_CHECKS).map(([rule, label]) => checkSubject(m, 'mcp', rule, label)),
      );
      // 旧探针可能只提供额外规则；已发现的风险也必须保留。
      subjects.push(
        ...tools.flatMap((m) =>
          checksOf(m)
            .filter(
              (c) => c.status === 'finding' && c.rule_id in MCP_RISKS && !(c.rule_id in MCP_CHECKS),
            )
            .map((c) => checkSubject(m, 'mcp', c.rule_id, MCP_RISKS[c.rule_id]!)),
        ),
      );
    } else if (f.ruleId === 'mcp_injection' || f.ruleId === 'mcp_transport') {
      subjects = tools.map((m) => {
        const subject = checkSubject(
          m,
          'mcp',
          f.ruleId === 'mcp_transport' ? 'mcp.transport' : 'mcp.descriptions',
          f.title,
        );
        if (
          f.ruleId === 'mcp_transport' &&
          !checksOf(m).some((c) => c.rule_id === 'mcp.transport')
        ) {
          const own = judgePosture(
            {
              mcp_servers: [
                {
                  transport: m.transport,
                  command_or_url: m.transport === 'stdio' ? null : m.origin,
                },
              ],
              collected_fields: ['mcp_servers'],
            },
            allowedHosts,
          ).find((x) => x.ruleId === 'mcp_transport')!;
          subject.state = own.state;
          subject.detail =
            own.state === 'clear'
              ? '已检查传输连接，未发现此项风险。'
              : own.state === 'risk'
                ? '传输连接不符合安全连接或允许访问的地址要求，请核对配置。'
                : subject.detail;
        }
        return subject;
      });
      if (f.ruleId === 'mcp_injection')
        subjects.push(
          ...tools.flatMap((m) =>
            checksOf(m)
              .filter(
                (c) =>
                  /^mcp\.description_(override|shadowing|exfil)$/.test(c.rule_id) &&
                  c.status === 'finding',
              )
              .map((c) =>
                checkSubject(m, 'mcp', c.rule_id, '工具描述试图劫持其他工具或越过安全限制'),
              ),
          ),
        );
    } else if (f.ruleId === 'skill_risk') {
      subjects = skills.flatMap((s) => {
        const checks = checksOf(s).filter((c) => c.rule_id in SKILL_RISKS);
        const own = [
          ...new Set(checks.length ? checks.map((c) => c.rule_id) : ['skill.script_patterns']),
        ].map((rule) => checkSubject(s, 'skill', rule, SKILL_RISKS[rule]!));
        const missing = Object.keys(SKILL_RISKS).filter(
          (rule) => !checks.some((c) => c.rule_id === rule),
        );
        // 脚本汇总项通过：全部受支持的行为都查过，没命中的就是没有，不再追加“其余几类没检查”。
        if (
          checks.length &&
          missing.length &&
          !scriptsFullyChecked(checks) &&
          !checks.some((c) => c.rule_id === 'skill.script_patterns' && c.status === 'unknown')
        ) {
          own.push(
            notCheckedSubject('skill', 'skill_rules_missing', {
              subjectKey: str(s.assetKey),
              name: safeName(s.name, '未命名技能'),
            }),
          );
        }
        return own;
      });
    } else if (f.ruleId === 'skill_source') {
      subjects = skills.map((s) => {
        const source = skillSource(s);
        const unknown = source !== null && /^(unknown|未知)?$/.test(source.trim());
        const base = { subjectKey: str(s.assetKey), name: safeName(s.name, '未命名技能') };
        if (source === null) return notCheckedSubject('skill', 'skill_source_missing', base);
        return {
          kind: 'skill',
          ...base,
          state: unknown ? 'risk' : 'clear',
          detail: unknown
            ? '技能来源登记为未知，无法追溯提供方。请补充可核实的来源后重新检测。'
            : '来源已登记。',
        };
      });
    } else if (f.ruleId === 'instruction_file') {
      const scanned = agents.filter((a) => instructionRows(a).length > 0);
      const covered = new Set(
        scanned.flatMap((a) =>
          arr(rec(rec(a.evidence).config).instruction_files)
            .filter((file) => file.scope === 'user' && str(file.path_hash))
            .map((file) => str(file.path_hash)),
        ),
      );
      subjects = scanned.map((a, index) => instructionSubject(a, index));
      subjects.push(
        ...assets
          .filter(
            (a) =>
              a.kind === 'instruction_file' &&
              !arr(rec(rec(a.evidence).config).instruction_files).some(
                (file) => Boolean(str(file.path_hash)) && covered.has(str(file.path_hash)),
              ),
          )
          .map((a) =>
            notCheckedSubject('instruction_file', 'instruction_file_unassessed', {
              name: safeName(a.name, '指令文件'),
            }),
          ),
      );
    }
    let droppedUnknown = 0;
    if (NEW_AGENT_RULES.includes(f.ruleId)) {
      droppedUnknown = subjects.filter((x) => x.state === 'not_checked').length;
      subjects = subjects.filter((x) => x.state !== 'not_checked');
    }
    // 某些版本把具体检查放在智能体资产层，不能因缺少嵌套对象而丢失。
    const assetRules = (rule: string) =>
      f.ruleId === 'skill_risk'
        ? rule in SKILL_RISKS
        : f.ruleId === 'mcp_risk'
          ? rule in MCP_CHECKS || rule in MCP_RISKS
          : f.ruleId === 'mcp_injection'
            ? /^mcp\.description_(override|shadowing|exfil)$/.test(rule) ||
              rule === 'mcp.descriptions'
            : f.ruleId === 'mcp_transport'
              ? rule === 'mcp.transport'
              : false;
    subjects.push(
      ...assets
        .filter((a) => a.kind !== 'mcp_server' && a.kind !== 'skill')
        .flatMap((a) =>
          checksOf(rec(a.evidence))
            .filter((c) => assetRules(c.rule_id))
            .map((c) =>
              checkSubject(
                { ...rec(a.evidence), name: fleetAgentIdentity(str(a.name)) },
                a.kind === 'scheduled_agent' ? 'scheduled_agent' : 'agent',
                c.rule_id,
                SKILL_RISKS[c.rule_id] ||
                  MCP_CHECKS[c.rule_id] ||
                  MCP_RISKS[c.rule_id] ||
                  '工具描述试图劫持其他工具或越过安全限制',
              ),
            ),
        ),
    );
    // 聚合有风险优先，其次保留任何未检查对象；不会用其他对象的通过盖住缺失。
    const verdict = subjects.length
      ? subjects.some((s) => s.state === 'risk')
        ? 'FAIL'
        : subjects.some((s) => s.state === 'review')
          ? 'UNKNOWN'
          : subjects.some((s) => s.state === 'not_checked')
            ? 'UNKNOWN'
            : 'PASS'
      : f.verdict;
    // 静态汇总仍可发现资产层风险；未知边界也不能被单个通过覆盖。
    const merged0 =
      f.verdict === 'FAIL' && f.ruleId !== 'skill_risk'
        ? 'FAIL'
        : f.ruleId === 'skill_risk' && f.verdict === 'UNKNOWN' && verdict === 'PASS'
          ? 'UNKNOWN'
          : verdict;
    const merged = droppedUnknown > 0 && merged0 === 'PASS' ? 'UNKNOWN' : merged0;
    const review = subjects.filter((s) => s.state === 'review');
    const unknown = subjects.filter((s) => s.state === 'not_checked');
    const evidence = subjects.length
      ? subjects
          .filter((s) => s.state === 'risk')
          .map((s) => `${s.name}：${s.detail}`)
          .join('；') ||
        (review.length
          ? `${review.length} 项命中位于说明文档或位置不明，需要人工确认。`
          : unknown.length
            ? `已有检查结果见下；另有 ${unknown.length} 项终端没有检查。`
            : '以下对象已完成检查，未发现此项风险。')
      : f.evidence;
    const description = CHECK_CATALOG.posture.find((item) => item.id === f.ruleId);
    return completeFinding({
      ...f,
      verdict: merged,
      ...(merged !== 'FAIL' && review.length ? { state: 'review' as const } : {}),
      subjects,
      evidence: merged === 'PASS' ? evidence + partialCollectionScope(report, subjects) : evidence,
      plainTitle: description?.title ?? f.plainTitle,
      plainWhy: description?.why ?? f.plainWhy,
      plainFix: description?.remediation ?? f.plainFix,
      notCheckedReason: unknown.length
        ? [...new Set(unknown.map((s) => s.detail))].join('；').slice(0, 1200)
        : f.notCheckedReason,
      howToCheck: unknownAdvice(unknown) || f.howToCheck,
    });
  });
}

/** 不回显采集日志中的路径、账户或配置正文，只把已知错误类别转成人话。 */
function partialCollectionScope(report: unknown, subjects: PostureSubject[]): string {
  const body = rec(report);
  const partial = arr(body.collectors).filter((c) => c.status === 'partial');
  if (!partial.length && body.status !== 'partial') return '';
  const rawErrors = [
    ...partial.flatMap((c) => {
      const errors = rec(c.stats).errors;
      return [...(Array.isArray(errors) ? errors : errors ? [errors] : []), c.error_code];
    }),
    ...(Array.isArray(rec(body.stats).errors) ? (rec(body.stats).errors as unknown[]) : []),
  ];
  const reasons = new Set<string>();
  let hasUnrecognized = false;
  for (const error of rawErrors) {
    if (!error) continue;
    const entry = rec(error);
    const value =
      typeof error === 'string'
        ? error
        : [entry.code, entry.error_code, entry.reason_zh, entry.message, entry.error]
            .filter((v) => typeof v === 'string')
            .join(' ');
    if (!value || value === 'collector_error') continue;
    const known = PARTIAL_COLLECTION_REASONS.find(([pattern]) => pattern.test(value));
    if (known) reasons.add(known[1]);
    else hasUnrecognized = true;
  }
  if (hasUnrecognized)
    reasons.add('报告有错误记录，但没有可识别的具体原因，请终端管理员查看采集日志');
  if (!reasons.size) reasons.add('终端没有提供具体原因，请终端管理员查看采集日志');
  const count = new Set(subjects.map((s) => `${s.kind}:${s.name}`)).size;
  return ` 本次采集有部分没完成（原因：${[...reasons].join('；')}），以上结论只覆盖已采集到的 ${count} 个对象，未采集到的对象不在本次结论范围内。`;
}
const PARTIAL_COLLECTION_REASONS: Array<[RegExp, string]> = [
  [/plugin.*fingerprint|插件.*指纹/i, '插件目录指纹检查失败'],
  [/plugin.*(?:install.*reference|reference.*unavailable)|插件.*安装.*引用/i, '插件安装引用不可用'],
  [
    /config.*(?:not_regular|not.*regular|not_regular_file)|配置.*不是.*(?:常规|普通).*文件/i,
    '智能体配置不是常规文件',
  ],
  [
    /skill.*(?:directory|dir|目录).*(?:unavailable|unreadable|missing|not_found|不可用|无法读取)|技能目录.*(?:不可用|无法读取)/i,
    '技能目录不可用或无法读取',
  ],
  [/permission_denied|EACCES|权限不足|无权读取/i, '读取配置的权限不足'],
];

const MCP_CHECKS: Record<string, string> = {
  'mcp.authorization': '访问授权',
  'mcp.credential': '凭据保护',
  'mcp.dependency': '依赖组件',
  'mcp.descriptions': '工具描述',
  'mcp.launch': '启动命令',
  'mcp.source': '工具来源',
  'mcp.transport': '传输连接',
};
function safeName(value: unknown, fallback: string) {
  return (
    str(value)
      .replace(/[\x00-\x1f\x7f]/g, '')
      .slice(0, 160) || fallback
  );
}
/** 没检查对象：原因文字取成因词表的“依据”，办法由词表在汇总处给出，对象上不再重复。 */
function notCheckedSubject(
  kind: PostureSubject['kind'],
  cause: NotCheckedCauseKey,
  base: Pick<PostureSubject, 'name'> & Partial<PostureSubject>,
): PostureSubject {
  return {
    kind,
    ...base,
    state: 'not_checked',
    cause,
    detail: notCheckedCause(cause)!.basis,
  };
}
/** 同一发现项下各成因的办法合并成一段：只有一类时直接给办法，多类时每类带上短标题。 */
function unknownAdvice(unknown: PostureSubject[]): string {
  const causes = [...new Set(unknown.map((s) => s.cause))]
    .map((key) => notCheckedCause(key))
    .filter((c): c is NonNullable<typeof c> => Boolean(c));
  if (!causes.length) return '';
  const text =
    causes.length === 1 ? causes[0]!.advice : causes.map((c) => `${c.title}：${c.advice}`).join('');
  return text.slice(0, 1200);
}
function checkSubject(
  holder: Rec,
  kind: PostureSubject['kind'],
  rule: string,
  label: string,
): PostureSubject {
  const checks = checksOf(holder).filter((c) => c.rule_id === rule);
  const hits = checks.filter((c) => c.status === 'finding');
  const state = hits.length
    ? !rule.startsWith('skill.') || hits.some((c) => skillHitState({ ...c }) === 'risk')
      ? 'risk'
      : 'review'
    : checks.length && checks.every((c) => c.status === 'pass')
      ? 'clear'
      : 'not_checked';
  const unknownCheck = checks.find((c) => c.status === 'unknown') ?? checks[0];
  const cause: NotCheckedCauseKey | undefined =
    state === 'not_checked'
      ? causeFromEvidenceCode(
          rule.startsWith('skill.') ? 'skill' : 'mcp',
          unknownCheck?.evidence_code,
        )
      : undefined;
  // 只有确认命中风险时才拼接风险描述；没检查只写原因，否则会被读成“该对象有高危行为”。
  const riskText = SKILL_RISKS[rule] || MCP_RISKS[rule] || `${label}不符合安全要求，请核对配置。`;
  return {
    kind,
    subjectKey: str(holder.assetKey),
    name: safeName(holder.name, kind === 'mcp' ? '未命名工具' : '未命名技能'),
    state,
    detail:
      state === 'risk'
        ? riskText
        : state === 'review'
          ? '命中位于说明文档或位置不明，请人工确认是否涉及实际执行。'
          : state === 'clear'
            ? '已检查，未发现此项风险。'
            : notCheckedCause(cause)!.basis,
    ...(cause ? { cause } : {}),
    ...(hits[0]
      ? {
          rule_id: hits[0].rule_id,
          reason_zh: riskText,
          file_label: hits[0].file_label,
          line_number: hits[0].line_number,
          context_type: hits[0].context_type,
          hits: hits.map((c) => ({ ...c, reason_zh: riskText })),
        }
      : {}),
  };
}
const AGENT_RISK_REASONS: Record<string, string> = {
  permissions:
    '该智能体配置了绕过权限确认或自动批准。请关闭跳过确认的设置，对敏感操作保留人工确认。',
  credentials: '该智能体配置存在凭据暴露风险。请移除明文凭据，改用安全保存方式并重新检测。',
  hooks: '该智能体没有接入所需的终端工具防护。请核对防护接入配置并重新检测。',
  sandbox_scope: '该智能体的沙箱允许完整主机访问。请改用受限沙箱，只开放专用工作目录。',
  sandbox_enabled: SANDBOX_OFF_REASONS.off,
  sandbox_bypass: '该智能体的配置允许命令不经沙箱运行。请关闭这些设置。',
  sandbox_credential_read: '沙箱内可以读取凭据目录。请把这些目录加入沙箱的拒绝读取名单。',
  model_destination: '该智能体调用的模型出口是中转站或未列入受管目录的地址。请改用官方接口或受管网关。',
  agent_version: '该智能体没有上报版本号，无法核对安全公告。请升级到可识别版本的安装包。',
  run_as_admin: '该智能体以管理员或 root 身份运行。请改用普通账号运行。',
  dir_scope: '该智能体被授予了主目录或系统目录的访问权限。请改为专用工作目录。',
  logging: '该智能体没有开启最细粒度的日志记录。请开启并保留日志。',
  listen_exposure: '该智能体的服务监听了局域网或所有网卡。请改为仅本机可访问。',
  install_source: '该智能体的安装物料来自修改版或第三方渠道。请改用官方渠道重新安装。',
  install_integrity: '该智能体的安装物料没有通过签名或杂凑值校验。请重新获取并校验。',
  broad_allow: '该智能体对命令或联网操作的授权范围过大。请按实际需要缩小范围并重新检测。',
};
/** 没检查的智能体对象为什么没检查：按规则看对应的配置状态，读取失败优先于其余。 */
function agentCause(asset: Rec, rule: string, kind: PostureSubject['kind']): NotCheckedCauseKey {
  if (kind === 'scheduled_agent') return 'scheduled_unassessed';
  if (rule === 'hooks')
    return checksOf(rec(asset.evidence)).some(
      (c) =>
        c.rule_id === 'config.hooks' &&
        c.status === 'unknown' &&
        c.evidence_code === 'hook_read_failed',
    )
      ? 'config_read_failed'
      : 'hooks_not_reported';
  if (rule === 'broad_allow') return 'broad_allow_not_reported';
  if (SANDBOX_RULES.includes(rule)) return sandboxVerdict(asset, rule).cause ?? 'check_missing';
  const items = agentConfigItems(asset);
  if (rule === 'sandbox_scope')
    return agentConfigCauses(items.filter((i) => i.item === 'sandbox'))[0] ?? 'check_missing';
  if (!['permissions', 'credentials'].includes(rule)) return 'check_missing';
  if (rule === 'credentials') {
    const check = checksOf(rec(asset.evidence)).find((c) => c.rule_id === 'config.credential');
    return !check || check.status !== 'unknown'
      ? 'check_missing'
      : items.some((i) => i.state === 'read_failed')
        ? 'credential_scan_blocked'
        : 'credential_no_files';
  }
  // 权限判定只看权限模式与自动批准两项，沙箱没读到不影响它。
  return agentConfigCauses(items.filter((i) => i.item !== 'sandbox'))[0] ?? 'check_missing';
}
function agentSubject(
  asset: Rec,
  rule: string,
  index: number,
  kind: PostureSubject['kind'] = 'agent',
  report?: unknown,
): PostureSubject {
  const e = rec(asset.evidence),
    c = rec(e.config);
  const config = {
    permissions: {
      ...(legacyConfigValue(c.permission_mode) && c.permission_mode !== 'unknown'
        ? { mode: legacyConfigValue(c.permission_mode) }
        : {}),
      ...(['enabled', 'disabled'].includes(legacyConfigValue(c.auto_approval))
        ? { skip_confirm: c.auto_approval === 'enabled' }
        : {}),
      ...(Array.isArray(c.allow) ? { allow: c.allow } : {}),
    },
    collected_fields: [],
    ...(Array.isArray(c.hooks) ? { hooks: c.hooks } : {}),
    ...(typeof e.managed_by_agentshield === 'boolean'
      ? { managed_by_agentshield: e.managed_by_agentshield }
      : {}),
    ...factsToInput([agentFacts(asset, true)]),
  };
  let verdict = judgePosture(config, [], { extended: true }).find((f) => f.ruleId === rule)!.verdict;
  const staticRules =
    rule === 'permissions'
      ? ['config.permission', 'config.auto_approval']
      : rule === 'credentials'
        ? ['config.credential']
        : rule === 'hooks'
          ? ['config.hooks']
          : rule === 'sandbox_scope'
            ? ['config.sandbox']
            : [];
  const checks = checksOf(e).filter((x) => staticRules.includes(x.rule_id));
  if (checks.some((x) => x.status === 'finding')) verdict = 'FAIL';
  else if (
    checks.length &&
    staticRules.every((r) => checks.some((x) => x.rule_id === r && x.status === 'pass')) &&
    checks.every((x) => x.status === 'pass')
  )
    verdict = 'PASS';
  else if (rule === 'hooks' && checks.length) verdict = 'UNKNOWN';
  // hooks_present=false 本身不能证明未接入防护，字段可能是旧探针占位。
  const state = verdict === 'FAIL' ? 'risk' : verdict === 'PASS' ? 'clear' : 'not_checked';
  const name = `${fleetAgentIdentity(safeName(asset.name, '未命名智能体'))}${str(asset.version) && asset.version !== 'version_unknown' ? ' ' + str(asset.version) : ''}（${kind === 'scheduled_agent' ? '定时运行' : '安装项'} ${index + 1}）`;
  const where = [agentOwnerAccount(asset, report), agentInstallLocation(asset)]
    .filter(Boolean)
    .join(' · ');
  const cause = state === 'not_checked' ? agentCause(asset, rule, kind) : undefined;
  const hookDetails: Record<string, string> = {
    hook_managed: '已由系统级托管设置接入。',
    hook_plugin: '已通过防护插件接入。',
    hook_user: '用户设置中已接入。',
  };
  return {
    kind,
    name,
    state,
    detail:
      state === 'risk'
        ? ((SANDBOX_RULES.includes(rule) ? sandboxVerdict(asset, rule).detail : undefined) ??
          AGENT_RISK_REASONS[rule] ??
          '发现该智能体配置存在风险，请核对配置。')
        : state === 'clear'
          ? ((rule === 'hooks' ? hookDetails[checks[0]?.evidence_code ?? ''] : undefined) ??
            '已检查该智能体配置，未发现此项风险。')
          : notCheckedCause(cause)!.basis,
    ...(cause ? { cause } : {}),
    ...(where ? { where } : {}),
  };
}

const INSTRUCTION_RISKS: Record<string, string> = {
  'instr.hidden_unicode': '指令文件含隐藏的方向控制或标签字符。',
  'instr.invisible_chars': '指令文件含零宽字符。',
  'instr.secret': '指令文件含疑似密钥。',
  'instr.suspicious_directive': '指令文件含要求绕过审批或向用户隐瞒操作的语句。',
};
function instructionRows(asset: Rec): Rec[] {
  return arr(rec(asset.evidence).posture).filter((p) =>
    Object.hasOwn(INSTRUCTION_RISKS, str(p.key)),
  );
}
/** 一处安装只生成一个内容检查对象；命中优先，未完成不能被其他文件的通过覆盖。 */
function instructionSubject(asset: Rec, index: number): PostureSubject {
  const rows = instructionRows(asset);
  const hits = rows.filter((p) => p.status === 'finding');
  const complete =
    Object.keys(INSTRUCTION_RISKS).every((key) =>
      rows.some((p) => p.key === key && p.status === 'pass'),
    ) && rows.every((p) => p.status === 'pass');
  const locations = hits.length ? hits : rows.filter((p) => p.status === 'unknown');
  const where = [
    ...new Set(
      locations
        .map((p) => {
          // 标签只保留文件名，不回显路径、指纹、证据码或命中内容。
          const label = safeText(str(p.label).split(/[\\/]/).pop(), 80);
          const scope = p.scope === 'user' ? '用户级' : p.scope === 'project' ? '项目级' : '';
          return [label, scope].filter(Boolean).join(' · ');
        })
        .filter(Boolean),
    ),
  ]
    .join('；')
    .slice(0, 160);
  const base = {
    name: `${fleetAgentIdentity(safeName(asset.name, '未命名智能体'))}${str(asset.version) && asset.version !== 'version_unknown' ? ' ' + str(asset.version) : ''}（安装项 ${index + 1}）`,
    ...(where ? { where } : {}),
  };
  if (!hits.length && !complete)
    return notCheckedSubject('agent', 'instruction_scan_incomplete', base);
  const count = Math.max(
    0,
    ...rows.map((p) => (typeof p.count === 'number' && Number.isFinite(p.count) ? p.count : 0)),
  );
  return {
    kind: 'agent',
    ...base,
    state: hits.length ? 'risk' : 'clear',
    detail: hits.length
      ? Object.entries(INSTRUCTION_RISKS)
          .filter(([key]) => hits.some((p) => p.key === key))
          .map(([, text]) => text)
          .join('；')
      : `已检查 ${count} 个指令文件，未发现隐藏字符、密钥或可疑指令。`,
  };
}

export function mcpAllowlist(): string[] {
  return (process.env.LSE_ENDPOINT_EVAL_MCP_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 体检报告摘要：资产按类型计数 + 静态检查命中数，不含原始报告正文。 */
export function summarizeReport(report: unknown) {
  const body = rec(report);
  const assets = arr(body.assets);
  const byKind: Record<string, number> = {};
  for (const a of assets)
    byKind[str(a.kind) || 'unknown'] = (byKind[str(a.kind) || 'unknown'] ?? 0) + 1;
  const inventory = reportInventory(report);
  byKind.skill = inventory.skills.length;
  byKind.mcp_server = inventory.mcp.length;
  const checks = [
    ...assets
      .filter((a) => a.kind !== 'skill' && a.kind !== 'mcp_server')
      .flatMap((a) => checksOf(rec(a.evidence))),
    ...inventory.skills.flatMap(checksOf),
    ...inventory.mcp.flatMap(checksOf),
  ];
  const isRisk = (c: Check) =>
    c.status === 'finding' &&
    (!c.rule_id.startsWith('skill.') || skillHitState({ ...c }) === 'risk');
  return {
    assetsByKind: byKind,
    agents: assets
      .filter((a) => AGENT_KINDS.has(str(a.kind)))
      .map((a) => ({ name: str(a.name), kind: str(a.kind), version: str(a.version) || null })),
    collectors: arr(body.collectors).map((c) => ({
      name: str(c.name),
      status: str(c.status),
      errorCode: str(c.error_code) || null,
    })),
    staticFindings: {
      review: checks.filter(
        (c) =>
          c.status === 'finding' &&
          c.rule_id.startsWith('skill.') &&
          skillHitState({ ...c }) === 'review',
      ).length,
      high: checks.filter((c) => isRisk(c) && c.severity === 'high').length,
      medium: checks.filter((c) => isRisk(c) && c.severity === 'medium').length,
      info: checks.filter((c) => isRisk(c) && c.severity === 'info').length,
    },
  };
}
