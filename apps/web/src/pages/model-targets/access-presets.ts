// 评估对象接入预设与接入类型标签。
// 「国家管网集团标准模型接口」仅为预设名称与说明，按 OpenAI 兼容 API 协议调用，不涉及私有协议。

export type ModelAccessPresetKey = 'local' | 'cloud' | 'pipechina';

export interface ModelAccessPreset {
  key: ModelAccessPresetKey;
  label: string;
  provider: string;
  description: string;
  baseUrlPlaceholder: string;
  examples: Array<{ label: string; baseUrl: string; model: string }>;
}

/** 招标原文（参数 4、5），界面直接引用，避免手工改写。 */
export const TENDER_TEXT_MODEL_ACCESS =
  '支持目标模型通过OpenAI兼容API接入，兼容本地模型服务、云端模型服务及国家管网集团标准模型接口。';
export const TENDER_TEXT_APP_ACCESS =
  '支持非标准业务接口或等效E2E接入能力，接入模型应用、智能体应用。';
export const TENDER_TEXT_CURL_IMPORT =
  '支持通过curl导入接口配置，自动识别URL、请求头、认证字段、请求体、提示词字段和响应字段。';
export const TENDER_TEXT_DIAGNOSE =
  '支持接入接口诊断，需对固定会话、异步轮询、SSE/NDJSON流式响应、认证失败和字段缺失等常见接入问题给出提示。';
export const TENDER_TEXT_BATCH_TEST =
  '支持单模型连通性测试和批量连通性测试，降低批量任务执行失败风险。';

export const MODEL_ACCESS_PRESETS: ModelAccessPreset[] = [
  {
    key: 'local',
    label: '本地模型服务',
    provider: 'openai-compatible-local',
    description:
      '本地或内网部署的推理服务，如 vLLM、Ollama、Xinference，均通过其 OpenAI 兼容接口（/v1）接入。本地服务不校验密钥时可填写任意值（如 EMPTY）。',
    baseUrlPlaceholder: 'http://127.0.0.1:8000/v1',
    examples: [
      { label: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1', model: 'Qwen2.5-7B-Instruct' },
      { label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
      { label: 'Xinference', baseUrl: 'http://127.0.0.1:9997/v1', model: 'qwen2.5-instruct' },
    ],
  },
  {
    key: 'cloud',
    label: '云端模型服务',
    provider: 'openai-compatible-cloud',
    description:
      '公有云或第三方大模型服务的 OpenAI 兼容接口，填写服务商提供的 Base URL、模型标识与 API Key。',
    baseUrlPlaceholder: 'https://api.example.com/v1',
    examples: [],
  },
  {
    key: 'pipechina',
    label: '国家管网集团标准模型接口',
    provider: 'pipechina-standard-openai',
    description:
      '国家管网集团标准模型接口按 OpenAI 兼容 API 协议接入：填写接口地址（Base URL）、模型标识与访问密钥，平台以 /chat/completions 调用。',
    baseUrlPlaceholder: 'https://模型服务地址/v1',
    examples: [],
  },
];

export function presetByProvider(provider: string | null | undefined): ModelAccessPreset | null {
  return MODEL_ACCESS_PRESETS.find((p) => p.provider === provider) ?? null;
}

/** 列表中的“接入类型”标签。 */
export function accessTypeLabel(targetType: string | null | undefined, provider: string): string {
  const type = targetType ?? 'MODEL';
  if (type === 'MODEL' || type === 'JUDGE') {
    const preset = presetByProvider(provider);
    return preset ? `OpenAI 兼容 API · ${preset.label}` : 'OpenAI 兼容 API';
  }
  if (type === 'AGENT_API' || type === 'PUBLIC_AGENT') return '非标准业务接口（E2E 接入）';
  if (type === 'GATEWAY_LOG') return '网关流量观测';
  return '资产登记';
}
