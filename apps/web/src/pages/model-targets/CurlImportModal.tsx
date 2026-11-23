import { useState, type ReactNode } from 'react';
import { CurlParseError, maskSecret, parseCurlCommand, type ParsedCurl } from '@lse/shared';
import { api, ApiError, type ModelTargetDiagnoseReport } from '@/lib/api';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { TENDER_TEXT_CURL_IMPORT } from './access-presets';

export type CurlApplyMode = 'model' | 'agent';

export interface CurlApplyPayload {
  mode: CurlApplyMode;
  parsed: ParsedCurl;
  responseTextPath: string | null;
}

const AUTH_LABEL: Record<ParsedCurl['auth']['type'], string> = {
  bearer: 'Bearer Token',
  api_key: 'API-Key 请求头',
  none: '未识别到认证字段',
};

/** 平台固定以 JSON 发送请求体，导入的 Content-Type 由平台统一设置，避免重复请求头。 */
export function stripContentType(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'content-type'),
  );
}

/** 认证以外仍可能携带凭据的请求头（Cookie、额外令牌等），界面仅遮蔽显示。 */
const SENSITIVE_HEADER_RE = /(cookie|token|secret|key|auth|session|password|credential)/i;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2 border-b border-border py-2 text-sm last:border-b-0">
      <div className="text-muted-foreground">{label}</div>
      <div className="min-w-0 break-all">{children}</div>
    </div>
  );
}

/** 从 curl 导入接口配置：浏览器本地解析，展示识别结果，用户确认后再填入表单。 */
export function CurlImportModal({
  open,
  onClose,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  onApply: (payload: CurlApplyPayload) => void;
}) {
  const [raw, setRaw] = useState('');
  const [parsed, setParsed] = useState<ParsedCurl | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<CurlApplyMode>('agent');
  const [probe, setProbe] = useState<ModelTargetDiagnoseReport | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [responsePath, setResponsePath] = useState<string | null>(null);

  const reset = () => {
    setParsed(null);
    setError(null);
    setProbe(null);
    setProbeError(null);
    setResponsePath(null);
  };

  const parse = () => {
    reset();
    try {
      const result = parseCurlCommand(raw);
      setParsed(result);
      setMode(result.openAiCompatible ? 'model' : 'agent');
    } catch (err) {
      setError(err instanceof CurlParseError ? err.message : '解析失败，请检查 curl 命令');
    }
  };

  // 试调用一次：按识别结果实际请求接口，根据真实响应推断响应字段。
  const tryOnce = async () => {
    if (!parsed) return;
    setProbing(true);
    setProbeError(null);
    try {
      const report = await api.modelTargets.diagnose({
        targetType: 'AGENT_API',
        baseUrl: parsed.url,
        apiKey: parsed.auth.value || undefined,
        accessConfig: {
          authType: parsed.auth.type,
          ...(parsed.auth.headerName ? { authHeaderName: parsed.auth.headerName } : {}),
          headers: stripContentType(parsed.headers),
          requestTemplate: parsed.requestTemplate ?? { input: '{{prompt}}' },
        },
      });
      setProbe(report);
      setResponsePath(report.responseCandidates[0] ?? null);
    } catch (err) {
      setProbeError(err instanceof ApiError ? err.message : '试调用失败');
    } finally {
      setProbing(false);
    }
  };

  const close = () => {
    setRaw('');
    reset();
    onClose();
  };

  const headerEntries = parsed ? Object.entries(parsed.headers) : [];

  return (
    <Modal
      open={open}
      onClose={close}
      title="从 curl 导入接口配置"
      description={TENDER_TEXT_CURL_IMPORT}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={close}>
            取消
          </Button>
          {parsed ? (
            <Button
              onClick={() => {
                onApply({ mode, parsed, responseTextPath: responsePath });
                close();
              }}
            >
              确认并填入表单
            </Button>
          ) : (
            <Button onClick={parse} disabled={!raw.trim()}>
              识别
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="curl-import-input" className="text-sm font-medium">
            curl 命令
          </label>
          <Textarea
            id="curl-import-input"
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              if (parsed) reset();
            }}
            placeholder={
              'curl -X POST \'https://agent.example.com/v1/chat-messages\' \\\n  -H \'Authorization: Bearer app-xxxx\' \\\n  -H \'Content-Type: application/json\' \\\n  -d \'{"query": "你好", "response_mode": "blocking"}\''
            }
            className="mt-1.5 min-h-[140px] font-mono text-xs"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            支持
            -X、-H、-d/--data/--data-raw/--json、-u、--url，多行反斜杠续行与单双引号。解析在浏览器本地完成，凭据不会写入日志。
          </p>
          {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
        </div>

        {parsed && (
          <section aria-label="curl 识别结果" className="rounded-md border border-border p-3">
            <div className="mb-2 text-sm font-semibold">识别结果（请确认）</div>
            <Row label="URL">
              <span className="font-mono text-xs">{parsed.url}</span>
            </Row>
            <Row label="请求方法">{parsed.method}</Row>
            <Row label="请求头">
              {headerEntries.length === 0 ? (
                <span className="text-muted-foreground">无</span>
              ) : (
                <ul className="space-y-0.5 font-mono text-xs">
                  {headerEntries.map(([k, v]) => (
                    <li key={k}>
                      {k}: {SENSITIVE_HEADER_RE.test(k) ? maskSecret(v) : v}
                    </li>
                  ))}
                </ul>
              )}
            </Row>
            <Row label="认证字段">
              {parsed.auth.type === 'none' ? (
                <span className="text-muted-foreground">{AUTH_LABEL.none}</span>
              ) : (
                <span>
                  <Badge tone="info">{AUTH_LABEL[parsed.auth.type]}</Badge>
                  <span className="ml-2 font-mono text-xs">
                    {parsed.auth.headerName ? `${parsed.auth.headerName}: ` : ''}
                    {parsed.auth.maskedValue}
                  </span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    来源：{parsed.auth.source}
                  </span>
                </span>
              )}
            </Row>
            <Row label="请求体">
              {parsed.rawBody === null ? (
                <span className="text-muted-foreground">无</span>
              ) : (
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-xs">
                  {parsed.requestTemplate !== null
                    ? JSON.stringify(parsed.requestTemplate, null, 2)
                    : parsed.rawBody}
                </pre>
              )}
            </Row>
            <Row label="提示词字段">
              {parsed.promptPath ? (
                <span>
                  <span className="font-mono text-xs">{parsed.promptPath}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    已替换为 {'{{prompt}}'}（原值：{(parsed.promptSample ?? '').slice(0, 60)}）
                  </span>
                </span>
              ) : (
                <span className="text-amber-700">
                  未识别，请在请求模板中手工替换为 {'{{prompt}}'}
                </span>
              )}
            </Row>
            <Row label="响应字段">
              {probe ? (
                probe.responseCandidates.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {probe.responseCandidates.map((path) => (
                      <button
                        key={path}
                        type="button"
                        onClick={() => setResponsePath(path)}
                        className={`rounded border px-2 py-0.5 font-mono text-xs ${
                          responsePath === path ? 'border-primary bg-primary/10' : 'border-border'
                        }`}
                        aria-pressed={responsePath === path}
                      >
                        {path}
                      </button>
                    ))}
                  </div>
                ) : (
                  <span className="text-muted-foreground">
                    {probe.answerSample
                      ? `已读取回答：${probe.answerSample.slice(0, 60)}`
                      : '未从响应中识别到文本字段'}
                  </span>
                )
              ) : (
                <span className="text-muted-foreground">需“试调用一次”后根据真实响应推断</span>
              )}
              <div className="mt-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void tryOnce()}
                  disabled={probing}
                >
                  {probing && <Spinner className="h-3.5 w-3.5" />}
                  试调用一次
                </Button>
                {probe && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    HTTP {probe.httpStatus ?? '-'}
                    {probe.streamFormat
                      ? ` · ${probe.streamFormat === 'sse' ? 'SSE' : 'NDJSON'} 流式`
                      : ''}
                  </span>
                )}
                {probeError && <span className="ml-2 text-xs text-destructive">{probeError}</span>}
              </div>
            </Row>
            {parsed.warnings.length > 0 && (
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-amber-700">
                {parsed.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            <fieldset className="mt-3 space-y-1.5 text-sm">
              <legend className="mb-1 font-medium">填入方式</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="curl-apply-mode"
                  checked={mode === 'model'}
                  disabled={!parsed.openAiCompatible}
                  onChange={() => setMode('model')}
                />
                按 OpenAI 兼容 API 模型接入
                {parsed.openAiCompatible ? (
                  <span className="text-xs text-muted-foreground">
                    （Base URL {parsed.openAiCompatible.baseUrl}
                    {parsed.openAiCompatible.model ? `，模型 ${parsed.openAiCompatible.model}` : ''}
                    ）
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    （接口不是 /chat/completions 形态）
                  </span>
                )}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="curl-apply-mode"
                  checked={mode === 'agent'}
                  onChange={() => setMode('agent')}
                />
                按非标准业务接口（模型应用、智能体应用）接入
              </label>
            </fieldset>
          </section>
        )}
      </div>
    </Modal>
  );
}
