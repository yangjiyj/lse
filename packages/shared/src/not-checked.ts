import type { EndpointRiskGroup, EndpointRiskRow } from './endpoint-overview.js';

/**
 * 「终端没检查」的成因词表。接口按成因给每一项没检查归类，前端按同一份词表呈现，
 * 保证“为什么没检查、谁来处理、怎么办”在列表、抽屉、任务页和报告里是同一句话。
 *
 * 处理方：
 * - admin：管理员改终端或配置就能补上；
 * - manual：探针按设计不做（例如不运行 MCP），需要人工核对；
 * - probe：探针现有能力查不了（也包括本来就没有可查的内容），管理员无需动作，
 *   等探针升级或配置出现后自动补查。
 *
 * 写法约定：basis 只陈述事实，不以“请”开头，不用“这些/这个”指代（分组行与单个对象共用）；
 * advice 只写下一步，且不得让人去做做不到的事（例如“开启采集”这类并不存在的开关）。
 */
export type NotCheckedOwner = 'admin' | 'manual' | 'probe';

export const NOT_CHECKED_OWNER_LABELS: Record<NotCheckedOwner, string> = {
  admin: '需管理员处理',
  manual: '需人工核对',
  probe: '暂时查不了',
};

/** 列表排序用：管理员能动手的排在最前。 */
export const NOT_CHECKED_OWNER_ORDER: Record<NotCheckedOwner, number> = {
  admin: 0,
  manual: 1,
  probe: 2,
};

export interface NotCheckedCause {
  owner: NotCheckedOwner;
  /** 列表里的状态徽标短语，不超过 6 字；缺省显示“终端没检查”。 */
  badge?: string;
  /** 作为风险行标题，不超过 30 字。 */
  title: string;
  /** 合并行标题里用的短名。 */
  short: string;
  /** 涉及对象的计量词，例如「个技能」，拼在数字后面。 */
  unit: string;
  /** 为什么没检查：事实陈述。 */
  basis: string;
  /** 下一步怎么办。 */
  advice: string;
  /** 对所有对象一律如此（例如探针不上报某类信息）：只给数量，不逐个列名。 */
  uniform?: boolean;
  /** 已被另一类成因的文字覆盖（例如凭据检查被配置读取失败挡住）：对象明细里保留，不单独成行。 */
  covered?: boolean;
}

const UPGRADE = '把终端探针升级到最新版本，下一次采集（约 15 分钟）自动补查。';

export const NOT_CHECKED_CAUSES = {
  // ── 技能 ──
  skill_scan_partial: {
    owner: 'probe',
    badge: '脚本没查完',
    title: '技能脚本检查没有完成',
    short: '脚本检查',
    unit: '个技能',
    basis: '脚本里有探针暂时解析不了的写法，或文件太大太多，没法判定是否安全。',
    advice: '不是权限问题，改配置补不上；重要的技能先人工看一遍脚本，探针支持后自动补查。',
  },
  skill_rules_missing: {
    owner: 'admin',
    badge: '规则没查全',
    title: '技能行为规则没有查全',
    short: '行为规则',
    unit: '个技能',
    basis: '终端只上报了部分技能行为规则的结果。',
    advice: UPGRADE,
  },
  skill_no_result: {
    owner: 'admin',
    badge: '没有结果',
    title: '技能脚本检查没有结果',
    short: '脚本结果',
    unit: '个技能',
    basis: '终端没有完成脚本检查，报告里也没有说明原因。',
    advice: UPGRADE,
  },
  skill_source_missing: {
    owner: 'admin',
    badge: '来源未上报',
    title: '技能来源没有上报',
    short: '技能来源',
    unit: '个技能',
    basis: '终端没有上报技能来源。',
    advice: UPGRADE,
  },
  // ── MCP ──
  mcp_dependency_unknown: {
    owner: 'manual',
    title: 'MCP 依赖组件没法核对',
    short: '依赖组件',
    unit: '个 MCP',
    basis: '本地进程类 MCP 的启动程序没有版本号，确认不了它依赖什么。',
    advice: '人工核对启动程序的来源；改用带固定版本号的包启动后可自动判定。',
  },
  mcp_descriptions_uncollected: {
    owner: 'manual',
    title: 'MCP 工具描述没有检查',
    short: '工具描述',
    unit: '个 MCP',
    basis: '探针只检查配置里自带的工具描述，不会为了扫描去启动 MCP 服务，这个 MCP 的配置里没有。',
    advice: '人工查看它的工具描述有没有诱导指令；目前没有可以开启的采集开关。',
  },
  mcp_descriptions_partial: {
    owner: 'manual',
    title: 'MCP 工具描述没有查全',
    short: '工具描述',
    unit: '个 MCP',
    basis: '配置里自带的工具描述超出检查上限，只查了一部分。',
    advice: '人工核对剩下的部分。',
  },
  mcp_launch_unverified: {
    owner: 'manual',
    title: 'MCP 启动命令没有验证',
    short: '启动命令',
    unit: '个 MCP',
    basis: '探针只记录启动命令，没有执行，也没有验证它实际做什么。',
    advice: '人工审核启动程序的来源、签名和运行权限。',
  },
  mcp_local_authorization_unknown: {
    owner: 'manual',
    title: 'MCP 本地授权范围没法核对',
    short: '本地授权',
    unit: '个 MCP',
    basis: '本地 MCP 继承当前用户的环境变量和文件权限，探针看不出它实际能用到什么。',
    advice: '人工核对它能访问的环境变量和文件，必要时收紧。',
  },
  mcp_remote_authorization_unknown: {
    owner: 'manual',
    title: 'MCP 远端授权范围没法核对',
    short: '远端授权',
    unit: '个 MCP',
    basis: '远端 MCP 配了授权字段，探针看不出服务端实际给了什么权限。',
    advice: '到 MCP 服务端核对令牌权限和来源域名。',
  },
  mcp_transport_unknown: {
    owner: 'admin',
    title: 'MCP 传输方式没法核对',
    short: '传输方式',
    unit: '个 MCP',
    basis: '远程 MCP 的地址解析不出来，判断不了是否加密传输。',
    advice: '把配置里的地址改成完整的 https 地址；下一次采集（约 15 分钟）自动更新。',
  },
  mcp_source_unknown: {
    owner: 'probe',
    title: 'MCP 来源记录不完整',
    short: '来源',
    unit: '个 MCP',
    basis: '探针没拿到这个 MCP 完整的来源指纹。',
    advice: '不用改配置，探针补齐来源指纹后自动判定。',
  },
  mcp_check_missing: {
    owner: 'admin',
    title: 'MCP 部分检查没有结果',
    short: '部分检查',
    unit: '个 MCP',
    basis: '终端没有上报这项检查的结果。',
    advice: UPGRADE,
  },
  // ── 智能体 ──
  config_read_failed: {
    owner: 'admin',
    title: '配置读取失败',
    short: '配置读取',
    unit: '处安装',
    basis:
      '探针读不到这个账号的配置，权限、沙箱和凭据检查都做不了：文件是符号链接（探针出于安全不跟随）、格式有误，或这个账号没有家目录。',
    advice:
      '符号链接换成真实文件、检查格式，下一次采集（约 15 分钟）自动更新。账号本来就没有家目录的，无需处理。',
  },
  config_unknown: {
    owner: 'probe',
    title: '权限与自动批准设置没读到',
    short: '权限与自动批准',
    unit: '处安装',
    basis: '权限模式和自动批准这两项至少有一项没读到：配置里没写，也没有可核实的官方默认值。',
    advice: '先在软件里确认；探针补上这个软件的规则后自动判定。',
  },
  config_internal_store: {
    owner: 'manual',
    title: '设置不在配置文件里',
    short: '软件内部设置',
    unit: '处安装',
    basis: '该软件把这些设置存在内部，探针读不到。',
    advice: '在软件的设置界面里确认。',
  },
  /** 只出现在对象明细里：同一批安装已经在“配置读取失败”里列出，不再单独成行。 */
  credential_scan_blocked: {
    owner: 'admin',
    title: '凭据检查被配置读取失败挡住',
    short: '凭据检查',
    unit: '处安装',
    basis: '这个账号的配置读不了，凭据检查没法做。',
    advice: '先处理“配置读取失败”，下一次采集自动补查。',
    covered: true,
  },
  credential_no_files: {
    owner: 'probe',
    title: '凭据检查没有取得配置内容',
    short: '凭据检查',
    unit: '处安装',
    basis: '没有可检查的配置文件，或文件过大、结构过深，确认不了有没有明文凭据。',
    advice:
      '该账号确实没有配置文件时无需处理，生成后会自动检查；有文件却一直没检查，到账号下核对。',
  },
  hooks_not_reported: {
    owner: 'probe',
    title: '防护接入状态没有上报',
    short: '防护接入',
    unit: '处安装',
    basis: '防护接入结果未上报，新版探针目前只检查 Claude Code。',
    advice: 'Claude Code 升级探针后重查，其他智能体先人工核对。',
    uniform: true,
  },
  broad_allow_not_reported: {
    owner: 'probe',
    title: '命令与网络授权没有上报',
    short: '命令与网络授权',
    unit: '处安装',
    basis: '探针目前不上报智能体的命令与网络授权清单。',
    advice: '等探针支持；在此之前人工核对授权范围。',
    uniform: true,
  },
  sandbox_not_reported: {
    owner: 'admin',
    title: '沙箱设置没有上报',
    short: '沙箱设置',
    unit: '处安装',
    basis: '终端探针没有上报沙箱的开关、绕开设置和可读范围。',
    advice: UPGRADE,
    uniform: true,
  },
  sandbox_unverifiable: {
    owner: 'manual',
    title: '沙箱设置没法核对',
    short: '沙箱设置',
    unit: '处安装',
    basis: '这项沙箱设置没有可核实的官方配置项，或不保存在探针能读的配置文件里。',
    advice: '在软件里人工确认。',
  },
  /** 只出现在对象明细里：同一处安装已经在“沙箱未开启”的风险里列出，不再单独成行。 */
  sandbox_not_enabled: {
    owner: 'admin',
    title: '沙箱没有开启，这一项查不了',
    short: '沙箱未开启',
    unit: '处安装',
    basis: '沙箱没有开启，绕开设置和可读范围无从检查。',
    advice: '先处理“沙箱未开启”，下一次采集自动补查。',
    covered: true,
  },
  scheduled_unassessed: {
    owner: 'probe',
    title: '定时任务调用的智能体没有检查',
    short: '定时任务',
    unit: '个定时任务',
    basis: '探针只发现定时任务里提到了智能体，没有读取被调用智能体的权限和授权设置。',
    advice: '人工核对定时任务调用的智能体及其权限，探针支持后自动补查。',
  },
  instruction_file_unassessed: {
    owner: 'probe',
    title: '指令文件没有内容检查',
    short: '指令文件',
    unit: '个指令文件',
    basis: '指令文件没有对应的内容检查结果。',
    advice: '等探针支持；在此之前人工核对这些文件。',
  },
  instruction_scan_incomplete: {
    owner: 'probe',
    title: '指令文件内容检查没有做完',
    short: '指令文件',
    unit: '处安装',
    basis: '指令文件过大、不是文本或读不了，或项目与规则文件检查达到上限、超时。',
    advice: '先人工核对指令文件；探针放宽检查上限或补齐读取能力后自动补查。',
  },
  // ── 平台 ──
  platform_version_unknown: {
    owner: 'probe',
    title: '平台版本漏洞没法判定',
    short: '版本漏洞',
    unit: '个平台',
    basis: '探针的漏洞版本对照没有覆盖当前版本，判断不了有没有已知漏洞。',
    advice: '对照厂商公告人工核对当前版本；探针补齐版本对照后自动判定。',
  },
  platform_image_no_version: {
    owner: 'admin',
    title: '平台镜像没写版本号',
    short: '镜像版本',
    unit: '个平台',
    basis: '镜像引用里没有具体版本号（例如 latest 或摘要），判断不了版本漏洞。',
    advice: '把镜像改成带具体版本号的标签；下一次采集（约 15 分钟）自动判定。',
  },
  platform_config_partial: {
    owner: 'probe',
    title: '平台配置没有读全',
    short: '配置读取',
    unit: '个平台',
    basis: '配置文件里有探针暂不支持的写法，或引用了读取清单之外的文件。',
    advice: '不是权限问题；升级探针到最新版本，仍读不全就等探针支持。',
  },
  platform_not_assessed: {
    owner: 'admin',
    title: '平台没有做配置体检',
    short: '配置体检',
    unit: '个平台',
    basis: '探针只识别出了这个平台，没有读取它的配置做体检，通常是探针版本太旧。',
    advice: UPGRADE,
  },
  platform_unread: {
    owner: 'probe',
    title: '平台这一项没读到',
    short: '部分检查',
    unit: '个平台',
    basis: '探针没取到这一项所需的容器信息。',
    advice: '重新采集后再看；仍没读到就是探针暂不支持。',
  },
  // ── 兜底 ──
  check_missing: {
    owner: 'admin',
    title: '终端没有提供这项检查',
    short: '检查项',
    unit: '处',
    basis: '终端没有上报这项检查的结果。',
    advice: `${UPGRADE}升级后仍没有，说明探针暂不支持这一项。`,
  },
} as const satisfies Record<string, NotCheckedCause>;

export type NotCheckedCauseKey = keyof typeof NOT_CHECKED_CAUSES;

export type NotCheckedCategory =
  | 'skill'
  | 'mcp'
  | 'credential'
  | 'permission'
  | 'platform'
  | 'coverage';

/** 没检查的行按所属领域归类，风险表“类别”列显示真实领域，不再统一写“检查覆盖”。 */
export function notCheckedCategory(key: string): NotCheckedCategory {
  if (key.startsWith('skill_')) return 'skill';
  if (key.startsWith('mcp_')) return 'mcp';
  if (key.startsWith('credential_')) return 'credential';
  if (key.startsWith('platform_')) return 'platform';
  if (
    key.startsWith('config_') ||
    key.startsWith('instruction_') ||
    key.startsWith('scheduled_') ||
    key.startsWith('sandbox_') ||
    key === 'hooks_not_reported' ||
    key === 'broad_allow_not_reported'
  )
    return 'permission';
  return 'coverage';
}

/** 词表外的键（旧响应、旧任务）返回 undefined，调用方退回原有文案。 */
export function notCheckedCause(key: string | undefined | null): NotCheckedCause | undefined {
  return key && Object.hasOwn(NOT_CHECKED_CAUSES, key)
    ? NOT_CHECKED_CAUSES[key as NotCheckedCauseKey]
    : undefined;
}

/** 技能没检查的成因，按“最先该说”的顺序：同一技能有多个成因时取靠前的。 */
export const SKILL_CAUSE_ORDER: readonly NotCheckedCauseKey[] = [
  'skill_scan_partial',
  'skill_no_result',
  'skill_rules_missing',
  'skill_source_missing',
];

/** 对象名去掉智能体安装序号：“Claude Code 2.1.126（安装项 2）” → “Claude Code 2.1.126”。 */
export function notCheckedSubjectLabel(name: string): string {
  return name.replace(/（(?:安装项|定时运行) \d+）$/, '');
}

/** 配置未显式设置、按官方默认值判断时的说明；默认值不代表无风险，风险结论以探针检查为准。 */
export const CONFIG_DEFAULT_NOTE = '配置未显式设置，按已核实的官方默认值读取。';

/**
 * 智能体配置三项状态 → 没读到的成因键，按处理优先级排序：读取失败（管理员能动手）在前。
 * 沙箱不参与权限判定，单独没读到不算；一处安装只取第一个，合并多处安装的抽屉可能出现多个。
 */
export function agentConfigCauses(
  items: ReadonlyArray<{ item: string; state: string }>,
): NotCheckedCauseKey[] {
  const states = items.filter((i) => i.item !== 'sandbox').map((i) => i.state);
  const all = items.map((i) => i.state);
  const out: NotCheckedCauseKey[] = [];
  if (all.includes('read_failed')) out.push('config_read_failed');
  if (all.includes('internal_store')) out.push('config_internal_store');
  if (states.includes('unknown')) out.push('config_unknown');
  return out;
}

/**
 * 探针证据码 → 成因键。MCP 的成因键与探针证据码同名，直接对应；
 * 技能只有脚本汇总一个来源：脚本没查完是 skill_scan_partial，其余（含完全没有结果）是 skill_no_result。
 */
export function causeFromEvidenceCode(
  family: 'skill' | 'mcp',
  code: string | undefined,
): NotCheckedCauseKey {
  if (family === 'skill')
    return code === 'script_scan_partial' ? 'skill_scan_partial' : 'skill_no_result';
  return code && code.startsWith('mcp_') && Object.hasOwn(NOT_CHECKED_CAUSES, code)
    ? (code as NotCheckedCauseKey)
    : 'mcp_check_missing';
}

export interface NotCheckedEntry {
  /** 成因键；词表外的键按 check_missing 处理。 */
  cause: string;
  name: string;
  detail?: string;
  /** 同一成因下的去重键；缺省按“名称 + 说明”去重。同名的不同安装用它区分。 */
  key?: string;
}

const SUBJECT_LIMIT = 50;
type Domain = 'agent' | 'skill' | 'mcp' | 'platform' | 'coverage';
const DOMAIN_LABEL: Record<Domain, string> = {
  agent: '智能体',
  skill: '技能',
  mcp: 'MCP',
  platform: '平台',
  coverage: '终端',
};
const DOMAIN_ORDER: Domain[] = ['agent', 'skill', 'mcp', 'platform', 'coverage'];
/** 合并行（一行含多类成因）的办法：只讲谁来处理，每一类各自的原因和办法在 groups 里。 */
export const NOT_CHECKED_GROUP_ADVICE: Record<NotCheckedOwner, string> = {
  admin: '按每一类的办法处理，下一次采集（约 15 分钟）自动补查。',
  manual: '按每一类的说明人工核对。',
  probe: '不用改配置，探针支持后自动补查。',
};
const CAUSE_ORDER = Object.keys(NOT_CHECKED_CAUSES);
function domainOf(cause: string): Domain {
  const category = notCheckedCategory(cause);
  return category === 'permission' || category === 'credential' ? 'agent' : category;
}
function mergedTitle(domain: Domain, shorts: string[]): string {
  const names = [...new Set(shorts)];
  let title = `${DOMAIN_LABEL[domain]}：`;
  let used = 0;
  for (const name of names) {
    const next = `${title}${used ? '、' : ''}${name}`;
    if (next.length > 20 && used > 0) break;
    title = next;
    used++;
  }
  return used < names.length ? `${title}等 ${names.length} 类` : title;
}

/**
 * 把没检查的对象按“谁处理 × 所属领域”合并成风险行：一行一个处理方和领域，
 * 点开后逐类说明原因和办法。同一类只出现一次，同一对象不重复计数。
 */
export function buildNotCheckedRows(entries: readonly NotCheckedEntry[]): EndpointRiskRow[] {
  const byCause = new Map<string, Map<string, { name: string; detail: string }>>();
  for (const entry of entries) {
    const key = notCheckedCause(entry.cause) ? entry.cause : 'check_missing';
    if ((NOT_CHECKED_CAUSES[key as NotCheckedCauseKey] as NotCheckedCause).covered) continue;
    const subjects = byCause.get(key) ?? new Map();
    subjects.set(entry.key ?? `${entry.name}\u0000${entry.detail ?? ''}`, {
      name: entry.name,
      detail: entry.detail ?? '',
    });
    byCause.set(key, subjects);
  }
  const rows = new Map<string, { owner: NotCheckedOwner; domain: Domain; causes: string[] }>();
  for (const key of byCause.keys()) {
    const owner: NotCheckedOwner = NOT_CHECKED_CAUSES[key as NotCheckedCauseKey].owner;
    const domain = domainOf(key);
    const id = `coverage.${owner}.${domain}`;
    const row = rows.get(id) ?? { owner, domain, causes: [] };
    row.causes.push(key);
    rows.set(id, row);
  }
  for (const row of rows.values())
    row.causes.sort((a, b) => CAUSE_ORDER.indexOf(a) - CAUSE_ORDER.indexOf(b));
  return [...rows]
    .sort(
      ([, a], [, b]) =>
        NOT_CHECKED_OWNER_ORDER[a.owner] - NOT_CHECKED_OWNER_ORDER[b.owner] ||
        DOMAIN_ORDER.indexOf(a.domain) - DOMAIN_ORDER.indexOf(b.domain),
    )
    .map(([id, { owner, domain, causes }]): EndpointRiskRow => {
      const groups = causes.map((key): EndpointRiskGroup => {
        const cause: NotCheckedCause = NOT_CHECKED_CAUSES[key as NotCheckedCauseKey];
        const all = [...byCause.get(key)!.values()];
        const listed = cause.uniform ? [] : all;
        return {
          cause: key,
          title: cause.title,
          basis: cause.basis,
          advice: cause.advice,
          subjectCount: all.length,
          subjects: listed.slice(0, SUBJECT_LIMIT),
          moreCount: Math.max(0, listed.length - SUBJECT_LIMIT),
        };
      });
      const single = groups.length === 1 ? groups[0]! : null;
      const flat = groups.flatMap((group) => group.subjects);
      // 逐个列名的总数：各组已截到 50 条，被截掉的数量在各组的 moreCount 里。
      const listedTotal = groups.reduce((n, g) => n + g.subjects.length + g.moreCount, 0);
      return {
        id,
        level: 'NOT_CHECKED',
        category: domain,
        title: single
          ? single.title
          : mergedTitle(
              domain,
              causes.map((key) => NOT_CHECKED_CAUSES[key as NotCheckedCauseKey].short),
            ),
        involved: single
          ? `${single.subjectCount} ${NOT_CHECKED_CAUSES[single.cause as NotCheckedCauseKey].unit}`
          : `${groups.length} 类检查`,
        // 合并行的依据列出各类的标题：比一句泛泛的“探针查不了”更能看出具体是哪几类。
        basis: single ? single.basis : groups.map((group) => group.title).join('；'),
        advice: single ? single.advice : NOT_CHECKED_GROUP_ADVICE[owner],
        owner,
        subjectCount: groups.reduce((n, g) => n + g.subjectCount, 0),
        subjects: flat.slice(0, SUBJECT_LIMIT),
        moreCount: Math.max(0, listedTotal - Math.min(flat.length, SUBJECT_LIMIT)),
        groups,
      };
    });
}

/** 风险表一行所需的固定字段；词表外的键按“终端没有提供这项检查”处理。 */
export function notCheckedRowFields(key: string | undefined | null, count: number) {
  const known = notCheckedCause(key);
  const cause: NotCheckedCause = known ?? NOT_CHECKED_CAUSES.check_missing;
  return {
    owner: cause.owner,
    title: cause.title,
    basis: cause.basis,
    advice: cause.advice,
    involved: `${count} ${cause.unit}`,
    category: notCheckedCategory(known ? String(key) : 'check_missing'),
  };
}

/** 管理员能动手的行数，用于概览卡片。 */
export function notCheckedAdminRows(rows: ReadonlyArray<{ owner?: NotCheckedOwner }>): number {
  return rows.filter((r) => r.owner === 'admin').length;
}
