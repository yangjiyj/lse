/**
 * 产品标识保留给接口与排查使用，显示名称面向终端管理员。
 * 表内产品与探针指纹库（probe/fingerprint/agents*.yaml）一致；探针新增产品时在此补一行，
 * 没补之前页面显示“未识别的智能体（原始标识：xxx）”，不会编造名称。
 */
const AGENT_DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
  gemini: 'Gemini',
  cursor: 'Cursor',
  'claude-desktop': 'Claude Desktop',
  ollama: 'Ollama',
  'custom-agent': 'Custom Agent',
  aider: 'Aider',
  continue: 'Continue',
  cline: 'Cline',
  'roo-cline': 'Roo Code',
  'pi-agent': 'Pi Agent',
  workbuddy: 'WorkBuddy',
  codebuddy: 'CodeBuddy',
  lingma: '通义灵码',
  qoder: 'Qoder',
  'qoder-cn': 'Qoder CN',
  'codebuddy-ide-cn': 'CodeBuddy CN 编辑器',
  trae: 'Trae',
  'trae-cn': 'Trae CN',
  marscode: 'Trae 插件',
  comate: '文心快码',
  'kimi-cli': 'Kimi CLI',
  iflow: 'iFlow CLI',
  'qwen-code': 'Qwen Code',
  'github-copilot': 'GitHub Copilot',
  'copilot-cli': 'GitHub Copilot 命令行',
  goose: 'Goose',
  amp: 'Amp',
  windsurf: 'Windsurf',
  kiro: 'Kiro',
  zed: 'Zed',
  'jetbrains-ai': 'JetBrains AI',
  junie: 'Junie',
  codegeex: 'CodeGeeX',
  'chatgpt-desktop': 'ChatGPT 桌面版',
  doubao: '豆包桌面版',
  'kimi-desktop': 'Kimi 桌面版',
  'tongyi-desktop': '通义千问桌面版',
  crush: 'Crush',
  droid: 'Droid CLI',
  'cursor-agent': 'Cursor CLI',
  auggie: 'Auggie CLI',
  'kilo-cli': 'Kilo Code CLI',
  plandex: 'Plandex',
  warp: 'Warp Agent CLI',
  'cline-cli': 'Cline CLI',
  'continue-cli': 'Continue CLI',
  'openhands-cli': 'OpenHands CLI',
  'kiro-cli': 'Kiro CLI',
  'mistral-vibe': 'Mistral Vibe',
  'kimi-code-desktop': 'Kimi Code 桌面端',
  'minimax-code': 'MiniMax Code',
  'cherry-studio': 'Cherry Studio',
  'lobehub-desktop': 'LobeHub Desktop',
  'lm-studio': 'LM Studio',
  gpt4all: 'GPT4All',
  'msty-studio': 'Msty Studio',
  'open-webui': 'Open WebUI',
  openhands: 'OpenHands',
  void: 'Void',
  'kilo-code': 'Kilo Code',
  augment: 'Augment Code',
  'amazon-q': 'Amazon Q Developer',
  'gemini-code-assist': 'Gemini Code Assist',
  tabnine: 'Tabnine',
  'sourcegraph-cody': 'Sourcegraph Cody',
  'google-antigravity': 'Google Antigravity',
  qodo: 'Qodo',
  'blackbox-ai': 'BLACKBOX AI',
  bito: 'Bito',
  pieces: 'Pieces',
  supermaven: 'Supermaven',
  'huawei-codearts-snap': '华为云码道 CodeArts',
  'lark-cli': '飞书命令行桥',
  'wecom-cli': '企业微信命令行桥',
  'dingtalk-dws': '钉钉命令行桥',
  'coze-cli': '扣子命令行桥',
  'kimi-kha': 'Kimi 托管智能体命令行',
  difyctl: 'Dify 云端命令行',
  'tencent-tccli': '腾讯云命令行',
  'power-platform-pac': '微软 Power Platform 命令行',
  'google-gcloud': '谷歌云命令行',
  'aws-cli': '亚马逊云命令行',
  'salesforce-sf': 'Salesforce 命令行',
  'openai-cli': 'OpenAI 管理命令行',
};
const DISPLAY_VALUES = new Set(Object.values(AGENT_DISPLAY_NAMES));
export function fleetAgentDisplayName(product: string): string {
  return Object.hasOwn(AGENT_DISPLAY_NAMES, product)
    ? AGENT_DISPLAY_NAMES[product]!
    : DISPLAY_VALUES.has(product)
      ? product
      : '未识别的智能体';
}
export function fleetAgentIdentity(product: string): string {
  const displayName = fleetAgentDisplayName(product);
  return Object.hasOwn(AGENT_DISPLAY_NAMES, product) || DISPLAY_VALUES.has(product)
    ? displayName
    : `${displayName}（原始标识：${product}）`;
}
/** 探针指纹库里的全部产品标识，供测试核对显示名表没有遗漏。 */
export const FLEET_KNOWN_AGENT_PRODUCTS: readonly string[] = Object.keys(AGENT_DISPLAY_NAMES);
