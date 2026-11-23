import type { ModelSeverity } from './types.js';

/** 模型目录里会被扫描的脚本语言（同时作为扫描结果的格式名）。 */
export const SCRIPT_LANGS = [
  'python',
  'javascript',
  'typescript',
  'shell',
  'powershell',
  'batch',
  'vbscript',
  'vba',
] as const;
export type ScriptLang = (typeof SCRIPT_LANGS)[number];

export interface ModelFileRuleDef {
  id: string;
  /** 规则类别（页面分组用） */
  category: string;
  /** detect：检测规则；note：解析、扫描过程和识别结果的提示（不计入检测规则数） */
  kind?: 'detect' | 'note';
  severity: ModelSeverity;
  title: string;
  description: string;
}
interface PatternRule extends ModelFileRuleDef {
  langs: readonly ScriptLang[];
  re: RegExp;
  /** 按命中内容定严重度；返回 null 表示这处不算命中。缺省用 severity。 */
  severityOf?: (m: RegExpMatchArray) => ModelSeverity | null;
}

/** 这些 COM 对象能执行命令、下载、写文件或调用 WMI，CreateObject 它们时升为中危。 */
const DANGEROUS_PROGID =
  /\b(?:WScript\.Shell|Shell\.Application|MSXML2\.|Microsoft\.XMLHTTP|ADODB\.Stream|WinHttp\.|Schedule\.Service|WbemScripting\.|winmgmts:|MMC20\.Application|ShellBrowserWindow|ShellWindows)/i;

/**
 * PowerShell 启动参数：隐藏窗口、-EncodedCommand、-Command 执行为中危；
 * 只绕过执行策略运行本地脚本（-File 或直接跟脚本名）为低危；单独 -NoProfile 等不算。
 */
function powershellSeverity(m: RegExpMatchArray): ModelSeverity | null {
  const s = ` ${m[0]}`;
  const hidden =
    /\s-w(?:i(?:n(?:d(?:o(?:w(?:s(?:t(?:y(?:l(?:e)?)?)?)?)?)?)?)?)?)?\s+(?:h(?:i(?:d(?:d(?:e(?:n)?)?)?)?)?|1)\b/i.test(
      s,
    );
  const encoded =
    /\s-e(?:c|n(?:c(?:o(?:d(?:e(?:d(?:c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?)?)?)?)?)?)?)?\s/i.test(
      s,
    );
  const command = /\s-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?\s/i.test(s);
  if (hidden || encoded || command) return 'MEDIUM';
  if (!/\s-(?:ep|ex(?:ec(?:ution(?:policy)?)?)?)\s+(?:bypass|unrestricted)\b/i.test(s)) return null;
  const file = /\s-f(?:ile)?\s+["']?([^\s"']+)/i.exec(s)?.[1] ?? '';
  return /^(?:\\\\|\/\/|https?:)/i.test(file) ? 'MEDIUM' : 'LOW';
}

const VBA_LANGS = ['vba', 'vbscript'] as const;
const WIN_LANGS = ['powershell', 'batch', 'vbscript', 'vba'] as const;

/**
 * 模型文件扫描新增的脚本规则：VBA 宏、Windows 脚本、反弹 Shell。
 * Python、JS/TS、Shell、PowerShell 另外复用组件扫描的代码规则（engines/ai-asset/engine/code-rules.ts）。
 */
export const SCRIPT_PATTERN_RULES: PatternRule[] = [
  {
    id: 'vba.auto_exec',
    category: 'VBA 宏',
    severity: 'LOW',
    title: '宏含自动执行入口',
    description:
      '检测到 AutoOpen、Document_Open、Workbook_Open 等打开文档即自动运行的宏入口。正常宏也常用，单独出现为低危；与执行命令、下载同时出现时另报严重问题。',
    langs: VBA_LANGS,
    re: /\b(?:Auto_?Open|Auto_?Close|AutoExec|AutoNew|Document_(?:Open|Close|New)|DocumentOpen|Workbook_(?:Open|Activate|BeforeClose))\b/i,
  },
  {
    id: 'vba.shell_exec',
    category: 'VBA 宏',
    severity: 'HIGH',
    title: '宏调用 Shell 执行程序',
    description:
      '检测到 Shell(…)、WScript.Shell、Shell.Application、ShellExecute 等执行外部程序的调用。',
    langs: VBA_LANGS,
    re: /\bShell\s*\(|\bShell\s+"|\bWScript\.Shell\b|\bShell\.Application\b|\.ShellExecute\b/i,
  },
  {
    id: 'vba.create_object',
    category: 'VBA 宏',
    severity: 'LOW',
    title: '宏创建 COM 对象',
    description:
      '检测到 CreateObject(…)、GetObject(…)。默认低危；对象为 WScript.Shell、Shell.Application、MSXML2.*、ADODB.Stream、WinHttp.*、WMI 等能执行命令、下载或写文件的时升为中危。',
    langs: VBA_LANGS,
    re: /\b(?:CreateObject|GetObject)\s*\(([^\n)]{0,160})/i,
    severityOf: (m) => (DANGEROUS_PROGID.test(m[1] ?? '') ? 'MEDIUM' : 'LOW'),
  },
  {
    id: 'vba.download',
    category: 'VBA 宏',
    severity: 'HIGH',
    title: '宏下载网络内容',
    description:
      '检测到 URLDownloadToFile、XMLHTTP、WinHttp 等下载网络内容的调用，常用于拉取后续恶意载荷。',
    langs: VBA_LANGS,
    re: /\bURLDownloadToFile\w*\b|XMLHTTP\b|\bWinHttp\.WinHttpRequest\b|\bWinHttpRequest\b|\bInternetExplorer\.Application\b/i,
  },
  {
    id: 'vba.environ',
    category: 'VBA 宏',
    severity: 'LOW',
    title: '宏读取环境变量',
    description:
      '检测到 Environ(…)，宏读取用户名、临时目录等环境信息，常与落地文件、外传信息配合。',
    langs: VBA_LANGS,
    re: /\bEnviron\$?\s*\(/i,
  },
  {
    id: 'vba.obfuscation',
    category: 'VBA 宏',
    severity: 'HIGH',
    title: '宏代码混淆（Chr 拼接或 Base64）',
    description:
      '检测到连续 Chr(…) 拼接字符串或 Base64 解码，正常宏很少这样写，通常用于隐藏命令或网址。',
    langs: VBA_LANGS,
    re: /(?:\bChrW?\$?\s*\(\s*\d+\s*\)\s*[&+]\s*(?:_\s*\r?\n\s*)?){4,}\bChrW?\$?\s*\(|\bbin\.base64\b|\bFromBase64String\b|\bBase64Decode\w*\s*\(|\bDecodeBase64\w*\s*\(/i,
  },
  {
    id: 'vba.shell_command',
    category: 'VBA 宏',
    severity: 'HIGH',
    title: '宏调用 PowerShell 或 cmd',
    description:
      '宏代码里出现 powershell、cmd /c、mshta、wscript、cscript 等命令行程序，用于执行系统命令。',
    langs: VBA_LANGS,
    re: /\b(?:powershell|pwsh)(?:\.exe)?\b|\bcmd(?:\.exe)?\s+\/[ck]\b|\bmshta(?:\.exe)?\b|\b[wc]script(?:\.exe)?\s+["\w/\\]/i,
  },
  {
    id: 'win.download_exec',
    category: 'Windows 脚本',
    severity: 'CRITICAL',
    title: '下载后直接执行（PowerShell）',
    description:
      '检测到 Net.WebClient/DownloadString、Invoke-WebRequest、Invoke-RestMethod 的结果交给 IEX/Invoke-Expression 执行。',
    langs: WIN_LANGS,
    re: /(?:\biex\b|\bInvoke-Expression\b)[^\n]{0,120}(?:DownloadString|DownloadData|Net\.WebClient|Invoke-WebRequest|Invoke-RestMethod|\biwr\b|\birm\b)|(?:DownloadString|DownloadData|Invoke-WebRequest|Invoke-RestMethod|\biwr\b|\birm\b)[^\n]{0,300}\|\s*(?:\biex\b|\bInvoke-Expression\b)/i,
  },
  {
    id: 'win.encoded_command',
    category: 'Windows 脚本',
    severity: 'HIGH',
    title: '执行编码后的 PowerShell 命令',
    description:
      '检测到 powershell -EncodedCommand（-enc/-e）或 FromBase64String 解码后交给 IEX 执行，用于隐藏真实命令。',
    langs: WIN_LANGS,
    re: /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]{0,200}\s-(?:e|ec|en|enc|enco|encodedcommand)\s+[A-Za-z0-9+/=]{16,}|\bFromBase64String\b[^\n]{0,200}(?:\biex\b|Invoke-Expression)|(?:\biex\b|Invoke-Expression)[^\n]{0,200}\bFromBase64String\b/i,
  },
  {
    id: 'win.lolbin',
    category: 'Windows 脚本',
    severity: 'HIGH',
    title: '利用系统自带程序下载或执行',
    description:
      '检测到 certutil -urlcache/-decode、bitsadmin /transfer、mshta 远程脚本、regsvr32 /i:http、rundll32 javascript: 等常见“就地取材”手法。',
    langs: WIN_LANGS,
    re: /\bcertutil(?:\.exe)?\b[^\n]{0,100}-(?:urlcache|decode)\b|\bbitsadmin(?:\.exe)?\b[^\n]{0,100}\/transfer\b|\bmshta(?:\.exe)?\s+["']?(?:https?:|vbscript:|javascript:)|\bregsvr32(?:\.exe)?\b[^\n]{0,100}\/i:\s*["']?https?:|\brundll32(?:\.exe)?\b[^\n]{0,100}javascript:/i,
  },
  {
    id: 'win.hidden_powershell',
    category: 'Windows 脚本',
    severity: 'MEDIUM',
    title: '隐藏窗口或绕过执行策略运行 PowerShell',
    description:
      '检测到 powershell -WindowStyle Hidden、-EncodedCommand、-Command 执行，为中危；只用 -ExecutionPolicy Bypass 运行本地脚本（安装、启动脚本常见写法）为低危，脚本在网络路径上仍为中危。',
    langs: WIN_LANGS,
    re: /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]{0,300}/i,
    severityOf: powershellSeverity,
  },
  {
    id: 'script.reverse_shell',
    category: '通用脚本',
    severity: 'CRITICAL',
    title: '反弹 Shell',
    description:
      '检测到 /dev/tcp/主机/端口、nc -e /bin/sh、socat exec、mkfifo 配合 nc 等把本机 Shell 交给远端的写法。',
    langs: SCRIPT_LANGS,
    re: /\/dev\/(?:tcp|udp)\/[^\s/"']+\/\d+|\bn(?:c|cat|etcat)\b[^\n]{0,80}\s-[a-z]*[ec]\s+["']?(?:\/bin\/)?(?:ba|z)?sh\b|\bsocat\b[^\n]{0,160}\bexec:|\bmkfifo\b[^\n]{0,160}\bn(?:c|cat)\b/i,
  },
];

/** 自动执行入口与执行命令、下载同时出现时，单独报一条严重问题。 */
export const AUTO_EXEC_PAYLOAD: ModelFileRuleDef = {
  id: 'vba.auto_exec_payload',
  category: 'VBA 宏',
  severity: 'CRITICAL',
  title: '自动执行的宏调用命令或下载',
  description:
    '同一宏既有打开即运行的入口，又调用 Shell、PowerShell/cmd 或下载网络内容，打开文档即会执行。',
};
export const AUTO_EXEC_PAYLOAD_PARTS = ['vba.shell_exec', 'vba.shell_command', 'vba.download'];

/** 配置文件规则（config.json、tokenizer_config.json、generation_config.json、YAML 等）。 */
export const CONFIG_RULES: ModelFileRuleDef[] = [
  {
    id: 'config.auto_map',
    category: '配置文件',
    severity: 'MEDIUM',
    title: '配置通过 auto_map 指向自定义代码',
    description:
      '加载时需 trust_remote_code，并执行 auto_map 指向的 .py；指向其他仓库（含 “--”）时会从该仓库下载代码，定为高危。被指向的本地 .py 一并扫描。',
  },
  {
    id: 'config.trust_remote_code',
    category: '配置文件',
    severity: 'MEDIUM',
    title: '配置要求信任远程代码',
    description: '配置里 trust_remote_code 为 true，加载模型时会执行仓库里的自定义 Python 代码。',
  },
  {
    id: 'config.suspicious_url',
    category: '配置文件',
    severity: 'MEDIUM',
    title: '配置含可疑链接',
    description:
      '配置里出现直接用 IP 的链接、指向脚本或可执行文件的链接，或常见的临时托管、回连探测域名。',
  },
  {
    id: 'config.command_fragment',
    category: '配置文件',
    severity: 'HIGH',
    title: '配置含命令或代码片段',
    description:
      '配置里出现 curl|sh、bash -c、/bin/sh、powershell、cmd /c、os.system、subprocess、__import__ 等命令或代码，模型配置不应包含这些内容。',
  },
  {
    id: 'config.yaml_python_tag',
    category: '配置文件',
    severity: 'HIGH',
    title: 'YAML 含 Python 对象标签',
    description:
      '检测到 !!python/object、!!python/name 等标签，用不安全方式加载（yaml.load、yaml.unsafe_load）时会执行任意代码。',
  },
];

/** 扫描过程本身的提示。 */
export const SCAN_NOTE_RULES: ModelFileRuleDef[] = [
  {
    id: 'SCRIPT_TRUNCATED',
    category: '扫描提示',
    severity: 'LOW',
    title: '脚本过大，仅检查了开头部分',
    description: '单个脚本超过读取上限，超出部分未检查。',
  },
  {
    id: 'CONFIG_TRUNCATED',
    category: '扫描提示',
    severity: 'LOW',
    title: '配置文件过大，仅检查了开头部分',
    description: '单个配置文件超过读取上限，超出部分未检查。',
  },
  {
    id: 'CONFIG_INVALID_JSON',
    category: '扫描提示',
    severity: 'LOW',
    title: '配置文件不是合法 JSON',
    description: '按 JSON 解析失败，只做了文本检查。',
  },
  {
    id: 'OFFICE_PARSE_ABORTED',
    category: '扫描提示',
    severity: 'MEDIUM',
    title: 'Office 文档解析中止',
    description: '宏文档不是有效的 ZIP 或读取 vbaProject.bin 失败，宏未检查。',
  },
];
