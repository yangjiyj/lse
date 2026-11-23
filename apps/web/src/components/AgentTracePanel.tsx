import type { EvalResultFinding } from '@/lib/api';
import {
  agentDecisionLabel,
  agentRiskSurfaceLabel,
  localizeAgentEvidence,
  severityLabel,
  toolNameLabel,
  verdictLabel,
  SEVERITY_TONE,
  VERDICT_TONE,
  type Severity,
  type Verdict,
} from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface AgentTracePanelProps {
  findings?: EvalResultFinding[] | null;
  className?: string;
}

interface TraceRow {
  key: string;
  attackPackVersion: string;
  caseId: string;
  seed: string;
  scenarioName: string;
  businessRole: string;
  attackVariant: string;
  toolBoundarySummary: string;
  successSignals: string;
  evidenceChain: string;
  remediation: string;
  verdict: string | null;
  riskSurface: string;
  toolName: string;
  argumentsSummary: string;
  allowed: boolean | null;
  observed: boolean;
  blockReason: string;
  turnLabel: string;
  severity: string | null;
}

const SENSITIVE_KEY_RE = /(token|secret|key|password|canary)/i;
const SENSITIVE_VALUE_RE = /(token|secret|password|canary|api[_-]?key|sk-[a-z0-9_-]+)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hashPrefix(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `hash:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function sanitize(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (SENSITIVE_KEY_RE.test(key) || SENSITIVE_VALUE_RE.test(value)) return hashPrefix(value);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, key));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, k)]));
  }
  return value;
}

function shortText(text: string, max = 160): string {
  const value = text.replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}...` : value || '—';
}

function shortJson(value: unknown): string {
  const text = JSON.stringify(sanitize(value)) ?? '—';
  return shortText(text);
}

function stringField(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '—';
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => (typeof item === 'string' && item.trim() ? [item.trim()] : []))
    : [];
}

function boundarySummary(value: unknown): string {
  if (!isRecord(value)) return '—';
  const allowed = stringList(value.allowedTools);
  const denied = stringList(value.deniedTools);
  const requires = stringList(value.requiresConfirmation);
  const dataPolicy = stringField(value.dataPolicy);
  return shortText(
    [
      allowed.length > 0 ? `允许：${allowed.join('、')}` : '',
      denied.length > 0 ? `禁止：${denied.join('、')}` : '',
      requires.length > 0 ? `需确认：${requires.join('、')}` : '',
      dataPolicy !== '—' ? dataPolicy : '',
    ]
      .filter(Boolean)
      .join('；'),
    220,
  );
}

function evidenceChainSummary(value: unknown): string {
  if (!Array.isArray(value)) return '—';
  const parts = value.slice(0, 4).flatMap((item) => {
    if (!isRecord(item)) return [];
    const step = typeof item.step === 'number' ? `步骤${item.step}` : '步骤';
    const decision = agentDecisionLabel(stringField(item.decision));
    const summary = stringField(item.summary);
    return [`${step}（${decision}）：${summary}`];
  });
  return parts.length > 0 ? shortText(parts.join('；'), 260) : '—';
}

function remediationSummary(value: unknown): string {
  if (!isRecord(value)) return '—';
  const owner = stringField(value.owner);
  const actions = stringList(value.actions);
  const retest = stringField(value.retest);
  return shortText(
    `${owner}：${actions.length > 0 ? actions.join('；') : '补充工具边界和运行时策略'}；复测：${retest}`,
    260,
  );
}

function traceRows(findings: EvalResultFinding[] | null | undefined): TraceRow[] {
  const rows: TraceRow[] = [];
  for (const finding of findings ?? []) {
    const detail = isRecord(finding.detail) ? finding.detail : null;
    const trace = Array.isArray(detail?.trace) ? detail.trace : [];
    for (const [index, item] of trace.entries()) {
      if (!isRecord(item)) continue;
      const turnIndex = typeof item.turnIndex === 'number' ? item.turnIndex : null;
      rows.push({
        key: `${finding.engine}-${rows.length}-${index}`,
        attackPackVersion: stringField(item.attackPackVersion ?? detail?.attackPackVersion),
        caseId: stringField(item.caseId ?? detail?.caseId ?? detail?.templateId),
        seed: stringField(item.seed ?? detail?.seed),
        scenarioName: stringField(detail?.scenarioName),
        businessRole: stringField(detail?.businessRole),
        attackVariant: stringField(detail?.attackVariant),
        toolBoundarySummary: boundarySummary(detail?.toolBoundary),
        successSignals: (() => {
          const signals = stringList(detail?.successSignals);
          return signals.length > 0 ? localizeAgentEvidence(signals.join('；')) : '本轮未确认风险';
        })(),
        evidenceChain: evidenceChainSummary(detail?.evidenceChain),
        remediation: remediationSummary(detail?.remediation),
        verdict:
          typeof item.verdict === 'string'
            ? item.verdict
            : typeof detail?.verdict === 'string'
              ? detail.verdict
              : (finding.verdict ?? null),
        riskSurface: typeof item.riskSurface === 'string' ? item.riskSurface : '',
        toolName: typeof item.toolName === 'string' ? item.toolName : '—',
        argumentsSummary:
          typeof item.argumentsSummary === 'string' && item.argumentsSummary.trim()
            ? shortText(item.argumentsSummary)
            : shortJson(item.arguments),
        allowed: typeof item.allowed === 'boolean' ? item.allowed : null,
        observed: item.observed === true,
        blockReason:
          typeof item.blockReason === 'string' && item.blockReason ? item.blockReason : '—',
        turnLabel: turnIndex === null ? '—' : `第 ${turnIndex + 1} 轮`,
        severity: typeof item.severity === 'string' ? item.severity : finding.severity,
      });
      if (rows.length >= 20) return rows;
    }
  }
  return rows;
}

export function AgentTracePanel({ findings, className }: AgentTracePanelProps) {
  const rows = traceRows(findings);
  if (rows.length === 0) return null;

  return (
    <div className={cn('overflow-hidden rounded-md border border-border bg-card', className)}>
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-foreground">智能体操作轨迹</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {rows.every((row) => row.observed)
              ? '展示平台实际执行的工具、调用参数和事后观测结果'
              : rows.some((row) => row.observed)
                ? '展示工具调用参数、关联风险及各轨迹的处置或观测结果'
                : '展示智能体拟调用的工具、调用参数、关联风险及评估沙箱处置结果'}
          </div>
        </div>
        <Badge tone="info">{rows.length} 条</Badge>
      </div>

      <div className="space-y-3 bg-muted/20 p-3">
        {rows.map((row) => (
          <article key={row.key} className="rounded-md border border-border bg-card p-3 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
              <div className="min-w-0 space-y-2">
                <div className="text-xs font-medium text-muted-foreground">调用概览</div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{row.turnLabel}</Badge>
                  <Badge tone="info">{toolNameLabel(row.toolName)}</Badge>
                  <Badge tone="warning">{agentRiskSurfaceLabel(row.riskSurface)}</Badge>
                </div>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Badge tone={VERDICT_TONE[row.verdict as Verdict] ?? 'neutral'}>
                  {verdictLabel(row.verdict)}
                </Badge>
                <Badge tone={SEVERITY_TONE[row.severity as Severity] ?? 'neutral'}>
                  {severityLabel(row.severity)}
                </Badge>
                {row.observed ? (
                  <Badge tone="info">平台已执行（事后观测）</Badge>
                ) : row.allowed === false ? (
                  <Badge tone="critical">评估沙箱已阻断</Badge>
                ) : row.allowed === true ? (
                  <Badge tone="success">未阻断</Badge>
                ) : (
                  <Badge tone="neutral">未知</Badge>
                )}
              </div>
            </div>

            <div className="mt-3 grid min-w-0 gap-3 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
              <section className="min-w-0 rounded-md border border-border bg-muted/20 p-3 lg:col-span-2">
                <div className="mb-2 text-xs font-medium text-muted-foreground">场景包</div>
                <dl className="grid gap-2 text-xs sm:grid-cols-[5rem_minmax(0,1fr)]">
                  <dt className="text-muted-foreground">场景</dt>
                  <dd className="min-w-0 break-words text-foreground">{row.scenarioName}</dd>
                  <dt className="text-muted-foreground">角色</dt>
                  <dd className="min-w-0 break-words text-foreground">{row.businessRole}</dd>
                  <dt className="text-muted-foreground">变体</dt>
                  <dd className="min-w-0 break-words text-foreground">{row.attackVariant}</dd>
                  <dt className="text-muted-foreground">风险判定依据</dt>
                  <dd className="min-w-0 break-words text-foreground">
                    {row.successSignals}
                    <span className="mt-1 block text-xs leading-4 text-muted-foreground">
                      此处列出本轮风险判定使用的证据；结论仅适用于当前样本和评估环境。
                    </span>
                  </dd>
                </dl>
              </section>

              <section className="min-w-0 rounded-md border border-border bg-muted/20 p-3">
                <details>
                  <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                    查看技术细节（测试来源）
                  </summary>
                  <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-[5rem_minmax(0,1fr)]">
                    <dt className="text-muted-foreground">测试场景</dt>
                    <dd className="min-w-0 break-words text-foreground">{row.scenarioName}</dd>
                    <dt className="text-muted-foreground">用例编号</dt>
                    <dd className="min-w-0 break-all font-mono text-foreground">{row.caseId}</dd>
                    <dt className="text-muted-foreground">随机种子</dt>
                    <dd className="min-w-0 break-all font-mono text-foreground">{row.seed}</dd>
                    <dt className="text-muted-foreground">用例版本</dt>
                    <dd className="min-w-0 break-all font-mono text-foreground">
                      {row.attackPackVersion}
                    </dd>
                  </dl>
                </details>
              </section>

              <section className="min-w-0 rounded-md border border-border bg-muted/20 p-3">
                <div className="mb-2 text-xs font-medium text-muted-foreground">参数摘要</div>
                <pre className="max-h-40 min-w-0 overflow-auto rounded-md bg-background p-3 font-mono text-xs leading-5 text-foreground">
                  <code>{row.argumentsSummary}</code>
                </pre>
              </section>

              <section className="min-w-0 rounded-md border border-border bg-muted/20 p-3 lg:col-span-2">
                <div className="mb-2 text-xs font-medium text-muted-foreground">工具边界</div>
                <div className="whitespace-pre-wrap break-words text-xs leading-5 text-foreground">
                  {localizeAgentEvidence(row.toolBoundarySummary)}
                </div>
              </section>

              <section className="min-w-0 rounded-md border border-border bg-muted/20 p-3 lg:col-span-2">
                <div className="mb-2 text-xs font-medium text-muted-foreground">证据链</div>
                <div className="whitespace-pre-wrap break-words text-xs leading-5 text-foreground">
                  {localizeAgentEvidence(row.evidenceChain)}
                </div>
              </section>

              <section className="min-w-0 rounded-md border border-border bg-muted/20 p-3 lg:col-span-2">
                <div className="mb-2 text-xs font-medium text-muted-foreground">
                  {row.observed ? '观测依据' : '阻断原因'}
                </div>
                <div className="whitespace-pre-wrap break-words text-xs leading-5 text-foreground">
                  {localizeAgentEvidence(row.blockReason)}
                </div>
              </section>

              <section className="min-w-0 rounded-md border border-border bg-muted/20 p-3 lg:col-span-2">
                <div className="mb-2 text-xs font-medium text-muted-foreground">整改建议</div>
                <div className="whitespace-pre-wrap break-words text-xs leading-5 text-foreground">
                  {row.remediation}
                </div>
              </section>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
