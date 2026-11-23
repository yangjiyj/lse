/**
 * AI-Infra-Guard 组件目录名 → 包生态/包名映射（导入期使用，结果写入 aig-vulns.json）。
 *
 * 只收录能确定的映射：依据是该目录下条目 references 指向的官方仓库，及该仓库对外发布的
 * PyPI/npm 包名（evidence 字段）。Go 二进制、桌面应用、仅 Docker 分发或 SaaS 形态的组件
 * （ollama、dify、anythingllm、librechat、comfyui、jupyter 系列等）不映射，不会产生依赖匹配。
 *
 * 同一目录混有子包/上游依赖条目（如 vllm 目录下的 xgrammar、joserfc），用 hints 归属：
 * 依次在 security_advise、summary、details 中找最早出现的匹配（同位置时子包优先于本包），
 * 命中 self 即归属本包；命中 drop 即不映射。个别无法用文本判断的条目写进 FILE_OVERRIDES。
 */
export type Ecosystem = 'pypi' | 'npm';

export interface PackageRef {
  ecosystem: Ecosystem;
  name: string;
}

export interface PackageHint {
  pattern: RegExp;
  /** 归属目标；null 表示该条目不属于可依赖匹配的包（丢弃映射）。 */
  target: PackageRef | null;
}

export interface ComponentMapping {
  /** AIG data/vuln 下的目录名（区分大小写，按实际目录）。 */
  dirs: string[];
  aliases: string[];
  primary: PackageRef;
  /** 本包自身名称的匹配式。 */
  self: RegExp;
  hints?: PackageHint[];
  evidence: string;
}

const py = (name: string): PackageRef => ({ ecosystem: 'pypi', name });
const npm = (name: string): PackageRef => ({ ecosystem: 'npm', name });

export const COMPONENT_MAPPINGS: ComponentMapping[] = [
  {
    dirs: ['langchain'],
    aliases: ['LangChain'],
    primary: py('langchain'),
    self: /langchain(?![-_\w/])/i,
    hints: [
      { pattern: /langchain[-_ ]?experimental/i, target: py('langchain-experimental') },
      { pattern: /langchain[-_]core/i, target: py('langchain-core') },
      { pattern: /langchain[-_]community|langchain community/i, target: py('langchain-community') },
      { pattern: /langchain[-_]text[-_]splitters/i, target: py('langchain-text-splitters') },
      { pattern: /langgraph[^。\n]{0,20}sqlite|checkpoint[-_]sqlite/i, target: py('langgraph-checkpoint-sqlite') },
      { pattern: /langgraph[-_ ]checkpoint|langgraph 的 `?JsonPlusSerializer/i, target: py('langgraph-checkpoint') },
      { pattern: /@langchain\/|langchain ?js/i, target: null },
      { pattern: /\bn8n\b/i, target: npm('n8n') },
      { pattern: /chatchat|chat-langchain|chatglm/i, target: null },
    ],
    evidence: 'references → github.com/langchain-ai/langchain；PyPI langchain 及拆分子包（PYSEC 条目）',
  },
  {
    dirs: ['vllm'],
    aliases: ['vLLM'],
    primary: py('vllm'),
    self: /vllm(?![-_\w])/i,
    hints: [
      { pattern: /xgrammar/i, target: py('xgrammar') },
      { pattern: /joserfc/i, target: py('joserfc') },
      { pattern: /vllm aibrix|aibrix/i, target: null },
      { pattern: /vllm-orchestrator|lollms/i, target: null },
    ],
    evidence: 'references → github.com/vllm-project/vllm；PyPI vllm',
  },
  {
    dirs: ['gradio'],
    aliases: ['Gradio'],
    primary: py('gradio'),
    self: /gradio(?![-_\w/])/i,
    hints: [{ pattern: /@gradio\/|gradio-video/i, target: null }],
    evidence: 'references → github.com/gradio-app/gradio 与 pypi.org/project/gradio',
  },
  {
    dirs: ['mlflow'],
    aliases: ['MLflow'],
    primary: py('mlflow'),
    self: /mlflow(?![-_\w])/i,
    hints: [{ pattern: /fickling/i, target: py('fickling') }],
    evidence: 'references → github.com/mlflow/mlflow 与 pypi.org/project/mlflow',
  },
  {
    dirs: ['openwebui', 'open-webui'],
    aliases: ['Open WebUI', 'openwebui', 'open-webui'],
    primary: py('open-webui'),
    self: /open[-_ ]?webui/i,
    evidence: 'references → github.com/open-webui/open-webui；官方 pip install open-webui',
  },
  {
    dirs: ['langflow'],
    aliases: ['Langflow'],
    primary: py('langflow'),
    self: /langflow(?![-_\w])/i,
    hints: [{ pattern: /langflow[-_]base/i, target: py('langflow-base') }],
    evidence: 'references → github.com/langflow-ai/langflow 与 pypi.org/project/langflow',
  },
  {
    dirs: ['LiteLLM', 'litellm'],
    aliases: ['LiteLLM'],
    primary: py('litellm'),
    self: /litellm/i,
    evidence: 'references → github.com/BerriAI/litellm 与 pypi.org/project/litellm',
  },
  {
    dirs: ['praisonai'],
    aliases: ['PraisonAI'],
    primary: py('praisonai'),
    self: /praisonai(?![-_\w])/i,
    hints: [
      { pattern: /praisonai[-_ ]?agents/i, target: py('praisonaiagents') },
      { pattern: /praisonai[-_ ]platform/i, target: py('praisonai-platform') },
      { pattern: /praisonaiui/i, target: null },
    ],
    evidence: 'references → github.com/MervinPraison/PraisonAI；pypi.org/project/praisonai-platform',
  },
  { dirs: ['sglang'], aliases: ['SGLang'], primary: py('sglang'), self: /sglang/i, evidence: 'github.com/sgl-project/sglang；PyPI sglang' },
  { dirs: ['ray'], aliases: ['Ray'], primary: py('ray'), self: /\bray\b/i, evidence: 'github.com/ray-project/ray；PyPI ray' },
  { dirs: ['bentoml'], aliases: ['BentoML'], primary: py('bentoml'), self: /bentoml/i, evidence: 'github.com/bentoml/BentoML；PyPI bentoml' },
  { dirs: ['crawl4ai'], aliases: ['Crawl4AI'], primary: py('crawl4ai'), self: /crawl4ai/i, evidence: 'github.com/unclecode/crawl4ai；PyPI crawl4ai' },
  { dirs: ['lmdeploy'], aliases: ['LMDeploy'], primary: py('lmdeploy'), self: /lmdeploy/i, evidence: 'github.com/InternLM/lmdeploy；PyPI lmdeploy' },
  { dirs: ['llamafactory'], aliases: ['LLaMA-Factory'], primary: py('llamafactory'), self: /llama[-_ ]?factory/i, evidence: 'github.com/hiyouga/LLaMA-Factory；PyPI llamafactory' },
  { dirs: ['crewai'], aliases: ['CrewAI'], primary: py('crewai'), self: /crewai/i, evidence: 'github.com/crewAIInc/crewAI；PyPI crewai' },
  { dirs: ['Xinference'], aliases: ['Xinference'], primary: py('xinference'), self: /xinference/i, evidence: 'github.com/xorbitsai/inference；PyPI xinference' },
  { dirs: ['fastchat'], aliases: ['FastChat'], primary: py('fschat'), self: /fastchat/i, evidence: 'github.com/lm-sys/FastChat；PyPI 发布名 fschat' },
  { dirs: ['pyload-ng'], aliases: ['pyLoad'], primary: py('pyload-ng'), self: /pyload/i, evidence: 'github.com/pyload/pyload；pypi.org/project/pyload-ng' },
  { dirs: ['tensorrt-llm'], aliases: ['TensorRT-LLM'], primary: py('tensorrt-llm'), self: /tensorrt/i, evidence: 'NVIDIA TensorRT-LLM；PyPI tensorrt-llm' },
  { dirs: ['guardrails-ai'], aliases: ['Guardrails'], primary: py('guardrails-ai'), self: /guardrails/i, evidence: '条目正文 pip install guardrails-ai；github.com/guardrails-ai/guardrails' },
  { dirs: ['mem0'], aliases: ['Mem0'], primary: py('mem0ai'), self: /mem0/i, evidence: 'github.com/mem0ai/mem0；PyPI 发布名 mem0ai' },
  { dirs: ['lightrag'], aliases: ['LightRAG'], primary: py('lightrag-hku'), self: /lightrag/i, evidence: 'github.com/HKUDS/LightRAG；PyPI 发布名 lightrag-hku' },
  { dirs: ['pipecat'], aliases: ['Pipecat'], primary: py('pipecat-ai'), self: /pipecat/i, evidence: 'github.com/pipecat-ai/pipecat；PyPI 发布名 pipecat-ai' },
  { dirs: ['instructlab'], aliases: ['InstructLab'], primary: py('instructlab'), self: /instructlab/i, evidence: 'PyPI instructlab' },
  { dirs: ['marimo'], aliases: ['marimo'], primary: py('marimo'), self: /marimo/i, evidence: 'github.com/marimo-team/marimo；PyPI marimo' },
  { dirs: ['feast'], aliases: ['Feast'], primary: py('feast'), self: /feast/i, evidence: 'github.com/feast-dev/feast；PyPI feast' },
  { dirs: ['langroid'], aliases: ['Langroid'], primary: py('langroid'), self: /langroid/i, evidence: 'github.com/langroid/langroid；PyPI langroid' },
  { dirs: ['upsonic'], aliases: ['Upsonic'], primary: py('upsonic'), self: /upsonic/i, evidence: 'github.com/Upsonic/Upsonic；PyPI upsonic' },
  {
    dirs: ['n8n'],
    aliases: ['n8n'],
    primary: npm('n8n'),
    self: /n8n(?![-_\w/])/i,
    hints: [
      { pattern: /n8n[-_]mcp/i, target: npm('n8n-mcp') },
      { pattern: /@n8n\/mcp-browser/i, target: null },
    ],
    evidence: 'references → github.com/n8n-io/n8n；npm n8n',
  },
  {
    dirs: ['flowise'],
    aliases: ['Flowise'],
    primary: npm('flowise'),
    self: /flowise(?![-_\w])/i,
    hints: [{ pattern: /flowise[-_]components/i, target: npm('flowise-components') }],
    evidence: 'references → github.com/FlowiseAI/Flowise；条目正文“npm 包 flowise”',
  },
  { dirs: ['openclaw'], aliases: ['OpenClaw'], primary: npm('openclaw'), self: /openclaw/i, evidence: '条目正文“包：openclaw（npm）”（54 条）' },
  { dirs: ['n8n-mcp'], aliases: ['n8n-MCP'], primary: npm('n8n-mcp'), self: /n8n-mcp/i, evidence: 'github.com/czlonkowski/n8n-mcp；npm n8n-mcp' },
  { dirs: ['mcp-server-kubernetes'], aliases: [], primary: npm('mcp-server-kubernetes'), self: /kubernetes/i, evidence: 'github.com/Flux159/mcp-server-kubernetes；npm mcp-server-kubernetes' },
  { dirs: ['agentic-flow'], aliases: [], primary: npm('agentic-flow'), self: /agentic-flow/i, evidence: 'github.com/ruvnet/agentic-flow；npm agentic-flow' },
];

/** 无法凭文本判断归属的个别条目：路径 → 归属（null = 不映射）。 */
export const FILE_OVERRIDES: Record<string, PackageRef | null> = {
  'data/vuln/vllm/CVE-2026-15574.yaml': null, // vllm-orchestrator-gateway，非 vllm 本体
  'data/vuln/n8n/CVE-2026-55608.yaml': npm('n8n-mcp'), // 摘要为 n8n-MCP，建议文本误写为 n8n
  'data/vuln/mlflow/CVE-2026-22607.yaml': py('fickling'),
};
