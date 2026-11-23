import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

/** 智能体应用 API（自定义 HTTP）接入字段：评估对象页与 RAG 专项评估页新建弹窗共用。 */
export interface AgentApiAccessState {
  baseUrl: string;
  apiKey: string;
  authType: 'bearer' | 'api_key' | 'none';
  authHeaderName: string;
  sessionHeaderName: string;
  customHeaders: string;
  requestTemplate: string;
  responseTextPath: string;
}

export const DEFAULT_REQUEST_TEMPLATE = '{\n  "input": "{{prompt}}",\n  "stream": false\n}';

export const EMPTY_AGENT_ACCESS: AgentApiAccessState = {
  baseUrl: '',
  apiKey: '',
  authType: 'bearer',
  authHeaderName: '',
  sessionHeaderName: '',
  customHeaders: '',
  requestTemplate: DEFAULT_REQUEST_TEMPLATE,
  responseTextPath: 'data.answer',
};

export type AgentAccessResult =
  | { ok: true; accessConfig: Record<string, unknown> }
  | { ok: false; error: string };

/** 由表单构造 accessConfig（不含安全网关字段，网关字段由调用方按需追加）。 */
export function buildAgentAccessConfig(f: AgentApiAccessState): AgentAccessResult {
  let requestTemplate: unknown;
  try {
    requestTemplate = JSON.parse(f.requestTemplate);
  } catch {
    return { ok: false, error: '请求模板 JSON 格式不正确' };
  }
  let headers: Record<string, string> | undefined;
  if (f.customHeaders.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(f.customHeaders);
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: '自定义请求头需为 JSON 对象，例如 {"X-App-Id": "demo"}' };
    }
    headers = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
    );
  }
  return {
    ok: true,
    accessConfig: {
      authType: f.authType,
      ...(f.authType === 'api_key' && f.authHeaderName.trim()
        ? { authHeaderName: f.authHeaderName.trim() }
        : {}),
      ...(f.sessionHeaderName.trim() ? { sessionHeaderName: f.sessionHeaderName.trim() } : {}),
      ...(headers ? { headers } : {}),
      requestTemplate,
      responseTextPath: f.responseTextPath.trim() || 'data.answer',
    },
  };
}

interface Props<T extends AgentApiAccessState> {
  form: T;
  setForm: (next: T) => void;
  /** 同时渲染接口地址与访问密钥（评估对象页与模型类共用这两项，由页面自行渲染）。 */
  withEndpoint?: boolean;
}

export function AgentApiAccessFields<T extends AgentApiAccessState>({ form, setForm, withEndpoint }: Props<T>) {
  const set = (patch: Partial<AgentApiAccessState>) => setForm({ ...form, ...patch });
  return (
    <>
      {withEndpoint && (
        <>
          <Field label="智能体调用接口 URL" htmlFor="target-base-url" required className="sm:col-span-2">
            <Input
              id="target-base-url"
              value={form.baseUrl}
              onChange={(e) => set({ baseUrl: e.target.value })}
              placeholder="https://agent.example.com/api/chat"
              className="font-mono text-xs"
            />
          </Field>
          <Field label="访问密钥（API Key）" htmlFor="target-api-key" hint="选填。填写接口提供方签发的访问密钥。">
            <Input
              id="target-api-key"
              type="password"
              value={form.apiKey}
              onChange={(e) => set({ apiKey: e.target.value })}
              placeholder="sk-..."
            />
          </Field>
        </>
      )}
      <Field
        label="认证方式"
        htmlFor="agent-auth-type"
        hint="优先使用 Bearer Token；接口定义不同时可切换认证方式。"
        className="sm:col-span-2"
      >
        <Select
          id="agent-auth-type"
          value={form.authType}
          onChange={(e) => set({ authType: e.target.value as AgentApiAccessState['authType'] })}
        >
          <option value="bearer">用密钥令牌验证（Bearer Token）</option>
          <option value="api_key">用 API-Key 请求头验证（X-API-Key）</option>
          <option value="none">不需要验证</option>
        </Select>
      </Field>
      {form.authType === 'api_key' && (
        <Field label="API-Key 请求头名称" htmlFor="agent-auth-header" hint="留空时使用 X-API-Key。">
          <Input
            id="agent-auth-header"
            value={form.authHeaderName}
            onChange={(e) => set({ authHeaderName: e.target.value })}
            placeholder="X-API-Key"
            className="font-mono text-xs"
          />
        </Field>
      )}
      <Field
        label="固定会话请求头（选填）"
        htmlFor="agent-session-header"
        hint="接口依赖会话标识时填写请求头名称；每道测评题使用独立会话 ID。请求模板中也可用 {{session_id}} 引用。"
      >
        <Input
          id="agent-session-header"
          value={form.sessionHeaderName}
          onChange={(e) => set({ sessionHeaderName: e.target.value })}
          placeholder="X-Session-Id"
          className="font-mono text-xs"
        />
      </Field>
      <AgentApiAccessMore form={form} set={set} />
    </>
  );
}

function AgentApiAccessMore<T extends AgentApiAccessState>({
  form,
  set,
}: {
  form: T;
  set: (patch: Partial<AgentApiAccessState>) => void;
}) {
  return (
    <>
      <Field
        label="自定义请求头（JSON，选填）"
        htmlFor="agent-custom-headers"
        className="sm:col-span-2"
        hint="业务接口需要的额外请求头，如租户或应用标识；已保存的敏感值以脱敏形式显示，不修改则保持原值。"
      >
        <Textarea
          id="agent-custom-headers"
          value={form.customHeaders}
          onChange={(e) => set({ customHeaders: e.target.value })}
          placeholder={'{\n  "X-App-Id": "demo"\n}'}
          className="min-h-[72px] font-mono text-xs"
        />
      </Field>
      <details className="sm:col-span-2 rounded-md border border-border bg-muted/20 p-3">
        <summary className="cursor-pointer text-sm font-medium text-foreground">高级设置（按需配置）</summary>
        <div className="mt-3 grid grid-cols-1 gap-4">
          <Field
            label="响应字段路径"
            htmlFor="agent-response-path"
            hint="指定接口返回中评估对象响应的字段路径，支持 choices[0].message.content 写法；默认 data.answer。SSE/NDJSON 流式响应会自动聚合。可用“接口诊断”推断候选路径。"
          >
            <Input
              id="agent-response-path"
              value={form.responseTextPath}
              onChange={(e) => set({ responseTextPath: e.target.value })}
              className="font-mono text-xs"
            />
          </Field>
          <Field
            label="请求模板"
            htmlFor="agent-request-template"
            hint="接口需要自定义参数时修改；{{prompt}} 将替换为测试样本内容。"
          >
            <Textarea
              id="agent-request-template"
              value={form.requestTemplate}
              onChange={(e) => set({ requestTemplate: e.target.value })}
              className="min-h-[120px] font-mono text-xs"
            />
          </Field>
        </div>
      </details>
    </>
  );
}
