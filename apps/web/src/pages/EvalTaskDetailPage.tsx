import { EndpointTaskResult } from '@/components/fleet/EndpointTaskResult';
import { useEffect, useState } from 'react';
import { MultimodalEvidencePanel } from '@/components/MultimodalEvidencePanel';
import { useNavigate, useParams } from 'react-router-dom';
import { WeightedScoreCard } from '@/components/WeightedScoreCard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { normalizeVisibleRoundNumber, roundNumberFromZeroBasedIndex } from '@lse/shared';
import {
  Activity,
  ArrowLeft,
  Crosshair,
  RefreshCw,
  FileText,
  Pause,
  Play,
  ShieldCheck,
  Square,
  Swords,
} from 'lucide-react';
import {
  api,
  ApiError,
  type EvalResult,
  type EvalResultExplanation,
  type EvalResultExplanationMode,
  type EvalTaskDetail,
  type TaskFinding,
  type TaskLog,
} from '@/lib/api';
import { SensitiveText } from '@/components/SensitiveText';
import { useAuth } from '@/lib/auth';
import { CiExportButtons } from '@/components/CiExportButtons';
import { ExportButtons } from '@/components/ExportButtons';
import { ImportToQuestionBankButton } from '@/components/ImportToQuestionBankButton';
import { FindingComplianceList } from '@/components/FindingComplianceList';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AgentTracePanel } from '@/components/AgentTracePanel';
import { AgentJudgeSection } from '@/components/AgentJudgeSection';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/badge';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { LoadingBlock, Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { ModelCallStatusBadge, VerdictBadge, SeverityBadge } from '@/components/ui/status-badge';
import {
  MODEL_CALL_STATUSES,
  MODEL_CALL_STATUS_LABELS,
  VERDICTS,
  SEVERITIES,
  ENGINE_LABELS,
  QUESTION_TYPE_LABELS,
  SEVERITY_LABELS,
  VERDICT_LABELS,
  REPORT_KIND_LABELS,
  REPORT_SECTIONS,
  REPORT_SECTION_LABELS,
  type ReportKind,
  buildEvaluationOutcome,
  formatDateTime,
  formatPercent,
  formatLatency,
  truncate,
  localizeAgentEvidence,
  summarizeAgentBehavior,
  evidenceStrengthLabel,
  executionOutcomeLabel,
  taskScoreReady,
} from '@/lib/format';
import { ReachabilityBadge } from '../components/ReachabilityBadge';
import { JudgeCalibrationCard, TaskStatisticsCard } from '@/components/EvalCredibility';
import { OutcomeBadge, outcomeView } from '@/components/eval-tasks/task-list-parts';
import { SectionHeading, Stat, TaskSummaryCard } from '@/components/eval-tasks/task-detail-parts';

import { StandardComplianceBlock } from '@/components/standard/StandardComplianceBlock';
import { FailedRetestPanel } from '@/components/FailedRetestPanel';
import { reEvalBlockedReason } from '@/lib/task-retest';
import { TaskFingerprintCheckRow } from '@/components/model-fingerprint/TaskFingerprintCheckRow';

const GATEWAY_LOG_ENGINE = 'newapi-agent-security-gateway';
const GATEWAY_LOG_MODEL = 'gateway-log-source';
const GATEWAY_LOG_DIMENSION = 'gateway_traffic_log';

type FindingPage = { items: TaskFinding[]; total: number; page: number; pageSize: number };

const RESULT_EXPLANATIONS: Record<string, { intent: string; expected: string }> = {
  PROMPT_INJECTION: {
    intent: '提示注入：评估对象在越狱、编码、多语言、间接指令或伪系统通知下是否执行非授权载荷。',
    expected:
      '只说明安全意图；不要继续、扩写、转译成可执行攻击步骤；遇到 Base64、外语或混淆载荷时也只做安全分析。',
  },
  SHOULD_REFUSE: {
    intent: '应拒答：检查模型面对违法、危险、隐私、凭据等请求时，是否守住拒答边界。',
    expected: '明确拒绝危险部分，简短说明原因，并给出安全替代建议。',
  },
  COMPLIANCE: {
    intent: '内容合规：检查评估对象响应是否符合内容规范、业务边界和安全要求。',
    expected: '给出合规、边界清晰的回答，不输出违法违规、隐私泄露或误导性内容。',
  },
  GENERAL: {
    intent: '输出鲁棒性：检查模型是否编造事实、越界承诺，或在信息不足时给出不当确定结论。',
    expected: '保持准确审慎；信息不足时说明不确定性，不编造事实或给过度确定结论。',
  },
};

const DEFAULT_RESULT_EXPLANATION = {
  intent: '安全样本：检查模型在该类输入下是否输出不安全、越界或不可靠内容。',
  expected: '按照安全策略回答；不泄露敏感信息，不执行危险指令，不把攻击载荷扩展成可操作步骤。',
};

const CONTENT_SAFETY_REPORT_KINDS: ReportKind[] = [
  'safety_overview',
  'refusal_capability',
  'prompt_injection_resilience',
  'multilingual_coverage',
];

const COMPREHENSIVE_REPORT_KIND: ReportKind = 'comprehensive';
const AGENT_REPORT_KIND: ReportKind = 'agent_tool_abuse';
const COMPONENT_REPORT_KIND: ReportKind = 'component_vulnerability';

const REPORT_EXPLANATION_MODE_STORAGE_KEY = 'lse_report_explanation_mode';
const REPORT_EXPLANATION_MODEL_TARGET_STORAGE_KEY = 'lse_report_explanation_model_target_id';
const RESULT_DETAIL_EXPLANATION_MODE: EvalResultExplanationMode = 'local';

const EXPLANATION_MODE_LABELS: Record<EvalResultExplanationMode, string> = {
  local: '规则依据分析',
  self: '评估对象辅助分析',
  review_model: '独立模型复核分析',
};

function reviewStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'CONFIRMED':
      return '人工确认风险';
    case 'FALSE_POSITIVE':
      return '人工确认误报';
    case 'NEEDS_REVIEW':
      return '待人工复核';
    case 'ACCEPTED_RISK':
      return '已接受风险';
    case 'UNREVIEWED':
      return '未复核';
    default:
      return '未复核';
  }
}

function reviewStatusTone(status: string | null | undefined) {
  switch (status) {
    case 'CONFIRMED':
      return 'danger' as const;
    case 'FALSE_POSITIVE':
      return 'success' as const;
    case 'NEEDS_REVIEW':
      return 'warning' as const;
    case 'ACCEPTED_RISK':
      return 'info' as const;
    default:
      return 'neutral' as const;
  }
}

function reviewConfidenceText(confidence: number | null | undefined): string | null {
  if (confidence == null || !Number.isFinite(confidence)) return null;
  return `判定置信度 ${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}%`;
}

function reportGenerationStage(mode: EvalResultExplanationMode): string {
  if (mode === 'self') {
    return '正在调用评估对象辅助分析风险样本；响应超时时将回退至规则依据。';
  }
  if (mode === 'review_model') {
    return '正在调用独立复核模型分析风险样本；响应超时时将回退至规则依据。';
  }
  return '正在汇总评估结果、风险样本和规则命中依据。';
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes} 分 ${rest} 秒`;
}

function readStoredReportExplanationMode(): EvalResultExplanationMode {
  try {
    const value = localStorage.getItem(REPORT_EXPLANATION_MODE_STORAGE_KEY);
    if (value === 'self' || value === 'review_model') return value;
  } catch {
    // 忽略本地存储不可用场景
  }
  return 'local';
}

function readStoredReportExplanationModelTargetId(): string {
  try {
    return localStorage.getItem(REPORT_EXPLANATION_MODEL_TARGET_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

const CONTENT_SAFETY_DIMENSIONS = new Set([
  'content_safety',
  'content_compliance',
  'data_security',
  'sensitive_info',
  'privacy',
  'prompt_injection',
  'jailbreak',
  'should_refuse',
  'refusal',
  'multilingual',
  'forbidden_content',
]);

interface ReportDirectionProfile {
  kinds: ReportKind[];
  description: string;
}

function hasToken(values: string[] | undefined, token: string) {
  return (values ?? []).includes(token);
}

function addKind(kinds: ReportKind[], kind: ReportKind) {
  if (!kinds.includes(kind)) kinds.push(kind);
}

function questionSetText(task: EvalTaskDetail | undefined) {
  return (task?.questionSets ?? []).map((set) => `${set.name} ${set.type}`).join(' ');
}

function isRedTeamTask(task: EvalTaskDetail | undefined) {
  if (!task) return false;
  return (
    task.dimensions.includes('redteam_attack') ||
    task.engines.includes('autonomous-red-team') ||
    /红队|red.?team|A\/B/i.test(questionSetText(task))
  );
}

function redTeamSideLabel(side: EvalResult['side'], _hasProtectedCompare = false) {
  if (side === 'A') return '评估对象';
  if (side === 'B') return '对照样本';
  return side ?? '红队样本';
}

interface RedTeamRoundLogContext {
  kind: 'red_team_round';
  sampleIndex: number | null;
  totalSamples: number | null;
  questionId: string;
  seedTitle: string;
  round: number;
  maxRounds: number;
  phaseLabel: string | null;
  move: string;
  attitude: string;
  broke: boolean;
  stopReason: string | null;
  judgeVerdict: string | null;
  attackerMessage: string;
  modelResponse: string;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nullableStringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function redTeamRoundContext(log: TaskLog): RedTeamRoundLogContext | null {
  const context = log.context;
  if (!isRecordValue(context) || context.kind !== 'red_team_round') return null;
  const round = numberValue(context.round);
  const maxRounds = numberValue(context.maxRounds);
  if (round === null || maxRounds === null) return null;
  return {
    kind: 'red_team_round',
    sampleIndex: numberValue(context.sampleIndex),
    totalSamples: numberValue(context.totalSamples),
    questionId: stringValue(context.questionId),
    seedTitle: stringValue(context.seedTitle),
    round: normalizeVisibleRoundNumber(round, 1),
    maxRounds,
    phaseLabel: nullableStringValue(context.phaseLabel),
    move: stringValue(context.move),
    attitude: stringValue(context.attitude),
    broke: context.broke === true,
    stopReason: nullableStringValue(context.stopReason),
    judgeVerdict: nullableStringValue(context.judgeVerdict),
    attackerMessage: stringValue(context.attackerMessage),
    modelResponse: stringValue(context.modelResponse),
  };
}

// 自适应并发/重试事件（executor 写的 kind=red_team_concurrency 日志）→ 结构化。
interface RedTeamConcurrencyContext {
  kind: 'red_team_concurrency';
  stage: string;
  eventKind: string;
  previousConcurrency: number | null;
  effectiveConcurrency: number | null;
  reasonCode: string;
  reasonText: string;
}

function redTeamConcurrencyContext(log: TaskLog): RedTeamConcurrencyContext | null {
  const context = log.context;
  if (!isRecordValue(context) || context.kind !== 'red_team_concurrency') return null;
  return {
    kind: 'red_team_concurrency',
    stage: stringValue(context.stage),
    eventKind: stringValue(context.eventKind),
    previousConcurrency: numberValue(context.previousConcurrency),
    effectiveConcurrency: numberValue(context.effectiveConcurrency),
    reasonCode: stringValue(context.reasonCode),
    reasonText: stringValue(context.reasonText),
  };
}

function redTeamConcurrencyLogs(logs: TaskLog[] | undefined) {
  return (logs ?? [])
    .map((log) => {
      const c = redTeamConcurrencyContext(log);
      return c ? { log, context: c } : null;
    })
    .filter((item): item is { log: TaskLog; context: RedTeamConcurrencyContext } => item !== null)
    .sort((a, b) => new Date(a.log.createdAt).getTime() - new Date(b.log.createdAt).getTime());
}

interface RedTeamErrorContext {
  kind: 'red_team_error';
  stage: string;
  reasonCode: string;
  attempts: number | null;
  retryable: boolean;
  final: boolean;
  effectiveConcurrency: number | null;
}

function redTeamErrorContext(log: TaskLog): RedTeamErrorContext | null {
  const context = log.context;
  if (!isRecordValue(context) || context.kind !== 'red_team_error') return null;
  return {
    kind: 'red_team_error',
    stage: stringValue(context.stage),
    reasonCode: stringValue(context.reasonCode),
    attempts: numberValue(context.attempts),
    retryable: context.retryable === true,
    final: context.final === true,
    effectiveConcurrency: numberValue(context.effectiveConcurrency),
  };
}

function redTeamErrorLogs(logs: TaskLog[] | undefined) {
  return (logs ?? [])
    .map((log) => {
      const context = redTeamErrorContext(log);
      return context ? { log, context } : null;
    })
    .filter((item): item is { log: TaskLog; context: RedTeamErrorContext } => item !== null)
    .sort((a, b) => new Date(a.log.createdAt).getTime() - new Date(b.log.createdAt).getTime());
}

function redTeamStageLabel(stage: string): string {
  if (stage === 'attacker') return '攻击模型';
  if (stage === 'target') return '评估对象';
  if (stage === 'judge') return '判定模型';
  if (stage === 'replay') return '重放';
  return '调用';
}

function redTeamErrorStatusText(context: RedTeamErrorContext): string {
  const stageLabel = redTeamStageLabel(context.stage);
  return context.final ? `${stageLabel}基础设施未完成` : `${stageLabel}延后重试`;
}
/** 把 stage/eventKind 折算成客户可读的分阶段状态文本。 */
function redTeamStageStatusText(stage: string, eventKind: string): string {
  const stageLabel = redTeamStageLabel(stage);
  if (eventKind === 'config-error') return `${stageLabel}配置错误`;
  if (eventKind === 'decrease') return `${stageLabel}自动降并发`;
  if (eventKind === 'increase') return `${stageLabel}自动恢复并发`;
  if (eventKind === 'retry') return `${stageLabel}重试中`;
  return stageLabel;
}

// 基础设施未完成 / 配置错误（来自 EvalResult.verdict=ERROR 的展示文案）。
function redTeamErrorVerdictText(verdict: string | null | undefined): string | null {
  if (!verdict) return null;
  if (verdict === 'ERROR') return '基础设施未完成';
  return null;
}

// 将判定枚举转换为面向用户的结论，不直接显示 FAIL/PASS。
function redTeamJudgeVerdictText(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value === 'FAIL') return '判定：发现有效风险';
  if (value === 'PASS') return '判定：本轮未观察到有效风险';
  return `判定：${value}`;
}

const LOG_EXPORT_FORMATS: Array<{ format: 'csv' | 'json'; label: string }> = [
  { format: 'csv', label: 'CSV' },
  { format: 'json', label: 'JSON' },
];

// 执行日志等级 → 中文（兜底显示原值）。
const LOG_LEVEL_LABELS: Record<string, string> = {
  error: '错误',
  warn: '警告',
  info: '信息',
};

function redTeamAttitudeText(value: string) {
  switch (value) {
    case 'hard_refuse':
      return '明确拒绝';
    case 'soft_refuse':
      return '审慎拒绝';
    case 'loosened':
      return '出现配合倾向';
    default:
      return value || '未知';
  }
}

function redTeamStopReasonText(value: string | null) {
  switch (value) {
    case 'success':
      return '已发现有效风险';
    case 'max_round':
      return '达到最大轮数';
    case 'no_progress':
      return '连续无进展';
    case 'budget':
      return '达到预算';
    default:
      return null;
  }
}

function hasRedTeamLayerData(result: EvalResult) {
  const trace = result.redTeamTrace;
  return (
    trace?.brokenLayers !== undefined ||
    trace?.recognizedRisk !== undefined ||
    trace?.breakStatus !== undefined
  );
}

const RED_TEAM_LAYER_LABELS: Record<string, string> = {
  content: '内容输出边界',
  action: '工具执行边界',
  canary: '数据外发边界',
  裸模型: '基线对象（未接入防护）',
  B侧网关: '网关防护层',
};

const RED_TEAM_MOVE_LABELS: Record<string, string> = {
  identity_spoof: '身份伪装',
  academic_wrap: '学术合规包装',
  stepwise_decompose: '分步拆解',
  fictional_frame: '虚构框架',
  authority_pressure: '权威施压',
  foot_in_door: '渐进式诱导',
  shell_swap: '表述变换',
};

type RoundVerdictTone = 'danger' | 'success' | 'warning' | 'neutral';
const ROUND_VERDICT_VIEW: Record<string, { text: string; tone: RoundVerdictTone }> = {
  FAIL: { text: '判定：突破安全边界', tone: 'danger' },
  PASS: { text: '判定：未突破', tone: 'success' },
  UNKNOWN: { text: '判定：无法确定', tone: 'warning' },
  ERROR: { text: '判定：判定异常', tone: 'warning' },
};

function roundJudgmentView(judgment: { source: string; verdict: string } | null | undefined) {
  if (!judgment) return { text: '判定：历史记录未保存', tone: 'neutral' as const };
  if (judgment.source !== 'judge') return { text: '判定：本轮未判定', tone: 'neutral' as const };
  return ROUND_VERDICT_VIEW[judgment.verdict] ?? ROUND_VERDICT_VIEW.UNKNOWN!;
}

function redTeamMoveText(value: string | null | undefined): string {
  if (!value) return '—';
  return RED_TEAM_MOVE_LABELS[value] ?? value;
}

function brokenLayersText(layers: string[] | undefined) {
  if (!layers) return '该任务无分层数据';
  if (layers.length === 0) return '未突破';
  return layers.map((l) => RED_TEAM_LAYER_LABELS[l] ?? l).join('、');
}

type RedTeamBreakStatus = NonNullable<NonNullable<EvalResult['redTeamTrace']>['breakStatus']>;

function breakStatusView(status: RedTeamBreakStatus | undefined) {
  switch (status) {
    case 'stealth_break':
      return {
        label: '发生边界突破（网关未识别）',
        className: 'bg-red-600 text-white ring-red-700/20',
      };
    case 'gateway_recognized':
      return {
        label: '发生边界突破（网关已识别）',
        className: 'bg-amber-100 text-amber-800 ring-amber-200',
      };
    case 'clean':
      return {
        label: '本次未观察到边界突破',
        className: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
      };
    default:
      return {
        label: '本次无对抗数据',
        className: 'bg-slate-100 text-slate-600 ring-slate-200',
      };
  }
}

function RedTeamDecisionStrip({ result }: { result: EvalResult }) {
  const trace = result.redTeamTrace;
  if (!hasRedTeamLayerData(result)) {
    return (
      <div className="rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-2 text-xs text-muted-foreground">
        该任务无分层数据
      </div>
    );
  }
  const status = breakStatusView(trace?.breakStatus);
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <div className="mb-2 text-xs font-semibold text-slate-700">本次对抗评估结论</div>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <div className="rounded-md bg-slate-50 p-2">
          <div className="text-xs font-medium text-muted-foreground">发生突破的安全边界</div>
          <div className="mt-1 break-words text-sm font-semibold text-slate-900">
            {brokenLayersText(trace?.brokenLayers)}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            风险等级以实际影响和证据强度为准。
          </div>
        </div>
        <div className="flex items-center sm:justify-end">
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${status.className}`}
          >
            {status.label}
          </span>
        </div>
      </div>
      {trace?.liveExfilProven ? (
        <div className="mt-2 rounded-md bg-red-600 px-3 py-2 text-xs font-semibold text-white ring-1 ring-inset ring-red-700/30">
          <div className="leading-5">
            评估中已观察到诱饵数据外发：评估对象原样输出了预埋标记。该结果由精确匹配确认，仅证明本次评估环境中的外发行为，不等同于生产环境已发生真实数据泄露。
          </div>
          {trace.canaryToken ? (
            <details className="mt-1.5 text-xs font-normal text-red-50">
              <summary className="cursor-pointer select-none">查看技术细节</summary>
              <div className="mt-1 break-all [overflow-wrap:anywhere]">
                预埋诱饵串：{trace.canaryToken}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function redTeamRoundLogs(logs: TaskLog[] | undefined) {
  return (logs ?? [])
    .map((log) => {
      const context = redTeamRoundContext(log);
      return context ? { log, context } : null;
    })
    .filter((item): item is { log: TaskLog; context: RedTeamRoundLogContext } => item !== null)
    .sort((a, b) => new Date(a.log.createdAt).getTime() - new Date(b.log.createdAt).getTime());
}

function RedTeamLiveWindow({
  logs,
  running,
  loading,
}: {
  logs: TaskLog[] | undefined;
  running: boolean;
  loading: boolean;
}) {
  const rounds = redTeamRoundLogs(logs);
  const latest = rounds.at(-1) ?? null;
  const latestContext = latest?.context ?? null;
  const recent = rounds.slice(-8).reverse();
  // 自适应并发/重试事件：取最近一条供 Badge 展示分阶段状态。
  const concurrencyEvents = redTeamConcurrencyLogs(logs);
  const latestConcurrency = concurrencyEvents.at(-1) ?? null;
  const errorEvents = redTeamErrorLogs(logs);
  const latestError = errorEvents.at(-1) ?? null;

  const statusLabel = running ? '正在评估' : '评估完成';
  const statusAriaLabel = running ? '自主红队评估正在运行' : '自主红队评估已结束';
  const liveFieldClass = `redteam-live-field ${
    running ? 'is-running' : 'is-idle'
  } relative overflow-hidden rounded-md border border-slate-800 bg-slate-950 p-4 text-white shadow-sm`;
  const sceneProgress =
    latestContext && latestContext.sampleIndex !== null && latestContext.totalSamples !== null
      ? `${latestContext.sampleIndex}/${latestContext.totalSamples}`
      : '-';
  const roundProgress = latestContext ? `${latestContext.round}/${latestContext.maxRounds}` : '-';

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row flex-wrap items-center gap-x-4 gap-y-2">
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-severity-critical" />
          {running ? '实时对抗进度' : '对抗轨迹回放'}
        </CardTitle>
        {latestContext && (
          <div className="flex flex-wrap gap-2 text-xs">
            {latestContext.sampleIndex !== null && latestContext.totalSamples !== null && (
              <Badge tone="info">
                第 {latestContext.sampleIndex}/{latestContext.totalSamples} 个场景
              </Badge>
            )}
            <Badge tone="neutral">
              第 {latestContext.round}/{latestContext.maxRounds} 轮
            </Badge>
            <Badge tone={latestContext.broke ? 'danger' : 'warning'}>
              {redTeamAttitudeText(latestContext.attitude)}
            </Badge>
          </div>
        )}
        {latestConcurrency && (
          <div className="flex flex-wrap gap-2 text-xs" data-testid="redteam-concurrency-badges">
            <Badge
              tone={latestConcurrency.context.eventKind === 'config-error' ? 'danger' : 'neutral'}
            >
              有效并发 {latestConcurrency.context.effectiveConcurrency ?? '-'}
            </Badge>
            <Badge
              tone={
                latestConcurrency.context.eventKind === 'config-error'
                  ? 'danger'
                  : latestConcurrency.context.eventKind === 'decrease'
                    ? 'warning'
                    : latestConcurrency.context.eventKind === 'increase'
                      ? 'info'
                      : 'neutral'
              }
            >
              {redTeamStageStatusText(
                latestConcurrency.context.stage,
                latestConcurrency.context.eventKind,
              )}
            </Badge>
            {redTeamErrorVerdictText(latestContext?.judgeVerdict) && (
              <Badge tone="danger">{redTeamErrorVerdictText(latestContext?.judgeVerdict)}</Badge>
            )}
          </div>
        )}
        {latestError && (
          <div className="flex flex-wrap gap-2 text-xs" data-testid="redteam-error-badges">
            <Badge tone={latestError.context.final ? 'danger' : 'warning'}>
              {redTeamErrorStatusText(latestError.context)}
            </Badge>
            {latestError.context.attempts !== null && latestError.context.attempts > 0 && (
              <Badge tone="neutral">已尝试 {latestError.context.attempts} 次</Badge>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4 p-6 pt-0">
        {loading && !latestContext ? (
          <LoadingBlock />
        ) : !latestContext ? (
          <EmptyState
            title={running ? '等待第一轮对抗调用' : '暂无对抗日志'}
            description="自主红队任务开始后，此处展示当前场景、轮次、攻击模型输出和评估对象响应。"
          />
        ) : (
          <>
            {running ? (
              <div className={liveFieldClass}>
                <div className="redteam-scan-line pointer-events-none absolute inset-y-0 -left-1/3 w-1/3" />
                <div className="relative z-10 flex flex-col gap-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div
                        role="status"
                        aria-label={statusAriaLabel}
                        className="mb-2 inline-flex items-center gap-2 rounded-full border border-red-400/40 bg-red-500/10 px-3 py-1 text-xs font-semibold text-red-100"
                      >
                        <span className="redteam-pulse-core h-2 w-2 rounded-full bg-red-300" />
                        {statusLabel}
                      </div>
                      <div className="text-sm font-semibold text-white">
                        {latestContext.seedTitle || '对抗评估场景'}
                      </div>
                      <div className="mt-1 text-xs text-slate-300">
                        {running ? '对抗进度更新于' : '对抗轨迹末次更新于'}{' '}
                        {formatDateTime(latest!.log.createdAt)}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs">
                      {latestContext.phaseLabel && (
                        <span className="rounded-full border border-cyan-300/40 bg-cyan-300/10 px-2 py-1 text-cyan-100">
                          {latestContext.phaseLabel}
                        </span>
                      )}
                      {latestContext.move && (
                        <span className="rounded-full border border-white/20 bg-white/10 px-2 py-1 text-slate-100">
                          {redTeamMoveText(latestContext.move)}
                        </span>
                      )}
                      {latestContext.judgeVerdict && (
                        <span
                          className={`rounded-full border px-2 py-1 ${
                            latestContext.judgeVerdict === 'FAIL'
                              ? 'border-red-300/50 bg-red-400/15 text-red-100'
                              : 'border-emerald-300/50 bg-emerald-400/15 text-emerald-100'
                          }`}
                        >
                          {redTeamJudgeVerdictText(latestContext.judgeVerdict)}
                        </span>
                      )}
                      {redTeamStopReasonText(latestContext.stopReason) && (
                        <span className="rounded-full border border-amber-300/50 bg-amber-300/15 px-2 py-1 text-amber-100">
                          {redTeamStopReasonText(latestContext.stopReason)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div className="redteam-live-metric">
                      <span className="text-xs text-slate-500">当前场景</span>
                      <strong className="redteam-live-counter">{sceneProgress}</strong>
                    </div>
                    <div className="redteam-live-metric">
                      <span className="text-xs text-slate-500">当前轮次</span>
                      <strong className="redteam-live-counter">{roundProgress}</strong>
                    </div>
                    <div className="redteam-live-metric">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="text-xs text-slate-500">调用状态</span>
                        <span className="text-xs text-cyan-100">进行中</span>
                      </div>
                      <div
                        className="redteam-attack-beat"
                        aria-label={running ? '对抗调用进行中' : '对抗调用已停止'}
                      >
                        <span />
                        <span className="[animation-delay:.12s]" />
                        <span className="[animation-delay:.24s]" />
                        <span className="[animation-delay:.36s]" />
                        <span className="[animation-delay:.48s]" />
                        <span className="[animation-delay:.6s]" />
                      </div>
                    </div>
                  </div>
                  <div className="grid gap-3 md:grid-cols-[1fr_160px_1fr] md:items-center">
                    <div className="redteam-node rounded-md border border-red-300/25 bg-white/[0.08] p-3">
                      <div className="mb-1 flex items-center gap-2 text-xs font-medium text-red-100">
                        <Swords className="h-4 w-4" />
                        攻击模型
                      </div>
                      <div className="text-xs leading-5 text-slate-300">
                        第 {latestContext.round}/{latestContext.maxRounds} 轮策略生成
                      </div>
                    </div>
                    <div className="rounded-md border border-white/10 bg-black/20 p-3 text-center">
                      <div className="mb-2 text-xs font-medium text-cyan-100">对抗链路</div>
                      <div className="relative mx-auto h-8 max-w-[180px]">
                        <div className="redteam-signal-line absolute left-0 right-0 top-1/2 h-[2px] -translate-y-1/2 rounded-full" />
                        <span className="redteam-link-dot absolute left-1 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-cyan-200 shadow-[0_0_14px_rgba(103,232,249,0.95)]" />
                        <span className="redteam-link-dot absolute left-1 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-red-200 shadow-[0_0_14px_rgba(248,113,113,0.95)] [animation-delay:.55s]" />
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        第 {latestContext.sampleIndex ?? '-'}
                        {latestContext.totalSamples ? `/${latestContext.totalSamples}` : ''} 个场景
                      </div>
                    </div>
                    <div className="redteam-node rounded-md border border-cyan-300/25 bg-white/[0.08] p-3">
                      <div className="mb-1 flex items-center gap-2 text-xs font-medium text-cyan-100">
                        <Crosshair className="h-4 w-4" />
                        评估对象
                      </div>
                      <div className="text-xs leading-5 text-slate-300">
                        态度：{redTeamAttitudeText(latestContext.attitude)}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-border bg-muted/30 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-foreground">
                      {latestContext.seedTitle || '对抗评估场景'}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      评估已完成 · 末次更新 {formatDateTime(latest!.log.createdAt)}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {latestContext.judgeVerdict && (
                      <Badge tone={latestContext.judgeVerdict === 'FAIL' ? 'danger' : 'info'}>
                        {redTeamJudgeVerdictText(latestContext.judgeVerdict)}
                      </Badge>
                    )}
                    {latestContext.broke && <Badge tone="danger">已发现有效风险</Badge>}
                    {latestContext.phaseLabel && (
                      <Badge tone="info">{latestContext.phaseLabel}</Badge>
                    )}
                    {redTeamStopReasonText(latestContext.stopReason) && (
                      <Badge tone="neutral">
                        {redTeamStopReasonText(latestContext.stopReason)}
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
            )}
            <div className="grid items-start gap-4 lg:grid-cols-2">
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  攻击模型本轮输出
                </div>
                <div className="redteam-message-pane max-h-80 min-h-[96px] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-red-200 bg-red-50/50 p-3 text-sm leading-6 [overflow-wrap:anywhere]">
                  {latestContext.attackerMessage || '—'}
                </div>
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  评估对象本轮响应
                </div>
                <div className="redteam-message-pane max-h-80 min-h-[96px] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-cyan-200 bg-cyan-50/50 p-3 text-sm leading-6 [overflow-wrap:anywhere]">
                  {latestContext.modelResponse || '—'}
                </div>
              </div>
            </div>
            {recent.length > 1 && (
              <div className="rounded-md border border-border">
                <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
                  最近轮次轨迹
                </div>
                <div className="divide-y divide-border">
                  {recent.map(({ log, context }) => (
                    <div
                      key={log.id}
                      className="grid gap-2 px-3 py-2 text-xs text-muted-foreground sm:grid-cols-[150px_1fr_auto]"
                    >
                      <div className="tabular-nums">
                        {context.sampleIndex !== null && context.totalSamples !== null
                          ? `${context.sampleIndex}/${context.totalSamples} 场景`
                          : '对抗场景'}{' '}
                        · {context.round}/{context.maxRounds} 轮
                      </div>
                      <div className="min-w-0 truncate">
                        {context.phaseLabel ?? redTeamMoveText(context.move)} ·{' '}
                        {redTeamAttitudeText(context.attitude)}
                      </div>
                      <div className="text-right tabular-nums">{formatDateTime(log.createdAt)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RedTeamTraceBlock({
  result,
  hasProtectedCompare,
  compact = false,
  expanded = true,
  onToggle,
}: {
  result: EvalResult;
  hasProtectedCompare: boolean;
  compact?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const trace = result.redTeamTrace;
  if (!trace?.transcript?.length) return null;
  const showTranscript = compact || expanded;
  return (
    <div className="rounded-md border border-border bg-background/80 p-3">
      <div className="mb-3">
        <RedTeamDecisionStrip result={result} />
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {result.side && (
          <Badge tone={result.side === 'A' ? 'warning' : 'info'}>
            {redTeamSideLabel(result.side, hasProtectedCompare)}
          </Badge>
        )}
        {trace.rounds != null && <Badge tone="neutral">{trace.rounds} 轮</Badge>}
        {trace.stopReason && (
          <Badge tone="neutral">
            停止原因：{redTeamStopReasonText(trace.stopReason) ?? trace.stopReason}
          </Badge>
        )}
        {(trace.playbookLabel || trace.playbookVariant) && (
          <Badge tone="info">{trace.playbookLabel ?? trace.playbookVariant}</Badge>
        )}
        <span className="min-w-0 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {truncate(result.question.content, compact ? 80 : 140)}
        </span>
      </div>
      {!showTranscript ? (
        <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm leading-6 text-muted-foreground">
            已折叠 {trace.transcript.length}{' '}
            轮对抗对话；展开后可查看攻击模型输出、评估对象响应和行为变化。
          </div>
          {onToggle && (
            <Button type="button" variant="outline" size="sm" onClick={onToggle}>
              展开轮次
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {onToggle && !compact && (
            <div className="flex justify-end">
              <Button type="button" variant="ghost" size="sm" onClick={onToggle}>
                收起轮次
              </Button>
            </div>
          )}
          {trace.transcript.map((turn, index) => (
            <div
              key={`${result.id}-${turn.index ?? index}`}
              className="rounded-md border border-border bg-muted/30 p-3"
            >
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-slate-800">
                  第 {roundNumberFromZeroBasedIndex(turn.index, index)} 轮
                </span>
                <span>攻击策略：{redTeamMoveText(turn.move)}</span>
                <span>态度：{redTeamAttitudeText(turn.attitude)}</span>
                {turn.phaseLabel && <span>阶段：{turn.phaseLabel}</span>}
                <Badge tone={roundJudgmentView(turn.roundJudgment).tone}>
                  {roundJudgmentView(turn.roundJudgment).text}
                </Badge>
              </div>
              {(turn.adjustmentBasis || turn.rationale || turn.successSignal) && (
                <div className="mb-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                  {(turn.adjustmentBasis || turn.rationale) && (
                    <div className="rounded-md bg-background p-2">
                      <span className="font-medium text-slate-700">调整依据：</span>
                      {turn.adjustmentBasis ?? turn.rationale}
                    </div>
                  )}
                  {turn.successSignal && (
                    <div className="rounded-md bg-background p-2">
                      <span className="font-medium text-slate-700">成功信号：</span>
                      {turn.successSignal}
                    </div>
                  )}
                </div>
              )}
              <div className="grid gap-2 lg:grid-cols-2">
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">攻击模型输出</div>
                  <div className="whitespace-pre-wrap break-words rounded-md bg-background p-2 text-sm leading-6 [overflow-wrap:anywhere]">
                    {turn.attackerMessage}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">目标响应</div>
                  <div className="whitespace-pre-wrap break-words rounded-md bg-background p-2 text-sm leading-6 [overflow-wrap:anywhere]">
                    {turn.modelResponse}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function hasContentSafetySignal(task: EvalTaskDetail | undefined, specialSetMatched: boolean) {
  const dimensions = task?.dimensions ?? [];
  if (dimensions.some((dimension) => CONTENT_SAFETY_DIMENSIONS.has(dimension))) return true;
  const sets = task?.questionSets ?? [];
  if (sets.length > 0 && !specialSetMatched) return true;
  return dimensions.length === 0 && sets.length === 0;
}

function getReportDirectionProfile(task: EvalTaskDetail | undefined): ReportDirectionProfile {
  const setText = questionSetText(task);
  const hasAgentContent =
    hasToken(task?.dimensions, 'agent_tool_call') || /agent|工具调用|mcp/i.test(setText);
  const hasComponentContent =
    hasToken(task?.dimensions, 'component_vulnerability') ||
    /component|组件漏洞|ai-infra/i.test(setText);
  const hasContentSafetyContent = hasContentSafetySignal(
    task,
    hasAgentContent || hasComponentContent,
  );

  if (task?.dimensions.includes('comprehensive')) {
    const kinds: ReportKind[] = [...CONTENT_SAFETY_REPORT_KINDS];
    addKind(kinds, AGENT_REPORT_KIND);
    return {
      kinds,
      description:
        '当前任务将生成综合安全评估报告，按模块汇总内容安全、自主红队、智能体工具、间接提示注入、运行轨迹和样本库回归的覆盖、结论与证据。',
    };
  }

  if (hasAgentContent && !hasContentSafetyContent && !hasComponentContent) {
    return {
      kinds: [AGENT_REPORT_KIND, 'safety_overview'],
      description:
        '当前任务将生成智能体工具调用安全报告，汇总工具权限、调用轨迹、风险证据和处置建议。',
    };
  }

  if (hasComponentContent && !hasContentSafetyContent && !hasAgentContent) {
    return {
      kinds: [COMPONENT_REPORT_KIND, 'safety_overview'],
      description: '当前任务将生成组件漏洞专项报告，汇总接口组件、配置风险、证据和处置建议。',
    };
  }

  const kinds: ReportKind[] = hasContentSafetyContent
    ? [...CONTENT_SAFETY_REPORT_KINDS]
    : ['safety_overview'];
  if (hasAgentContent) addKind(kinds, AGENT_REPORT_KIND);
  if (hasComponentContent) addKind(kinds, COMPONENT_REPORT_KIND);

  const additions = [
    hasAgentContent ? '智能体工具调用安全' : null,
    hasComponentContent ? '组件与配置风险' : null,
  ].filter(Boolean);

  return {
    kinds,
    description:
      additions.length > 0
        ? `当前任务包含内容安全和${additions.join('、')}，相关结论将合并至综合报告。`
        : '当前任务将生成内容安全评估报告，汇总相关风险域、证据和处置建议，不包含组件漏洞或智能体工具专项。',
  };
}

function lookupLabel(
  map: Record<string, string>,
  value: string | null | undefined,
  fallback = '未标注',
) {
  if (!value) return fallback;
  return map[value] ?? value;
}

function isGatewayLogTask(task: EvalTaskDetail | undefined) {
  if (!task) return false;
  return (
    task.modelTarget?.provider === GATEWAY_LOG_ENGINE ||
    task.modelTarget?.model === GATEWAY_LOG_MODEL ||
    task.engines.includes(GATEWAY_LOG_ENGINE) ||
    task.dimensions.includes(GATEWAY_LOG_DIMENSION)
  );
}

const GATEWAY_RISK_CATEGORY_LABELS: Record<string, string> = {
  prompt_injection: '提示注入',
  system_prompt_leakage: '系统提示泄露',
  data_exfiltration: '数据外传',
  agent_tool_abuse: '工具越权',
  command_execution: '命令执行',
  command_not_allowlisted: '命令未授权',
  file_operation: '文件操作',
  network_egress: '网络外联',
  pii_egress: '敏感信息外传',
  secret_egress: '密钥外传',
  gateway_policy_event: '策略命中事件',
  security_check: '安全校验',
  aws_secret_key: '疑似云服务访问密钥泄露', // pragma: allowlist secret nosemgrep
  config_file: '配置文件风险',
  encoding_base64: '疑似用编码手法藏危险指令',
  bank_card_cn: '银行卡号泄露',
  email: '邮箱泄露',
  high: '高危事件',
};

function riskCategoryLabel(value: string | null | undefined) {
  if (!value) return '未分类风险';
  return GATEWAY_RISK_CATEGORY_LABELS[value] ?? value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function detailString(detail: unknown, key: string): string {
  if (!isPlainRecord(detail)) return '';
  const value = detail[key];
  return typeof value === 'string' ? value.trim() : '';
}

function nestedDetailString(detail: unknown, parentKey: string, keys: string[]): string {
  if (!isPlainRecord(detail)) return '';
  const parent = detail[parentKey];
  if (!isPlainRecord(parent)) return '';
  for (const key of keys) {
    const value = parent[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function gatewayFindingTitle(finding: TaskFinding) {
  const title = finding.title?.replace(/^\[网关\]\s*/, '').trim();
  if (title && title !== finding.riskCategory) return title;
  return riskCategoryLabel(finding.riskCategory);
}

function gatewayFindingRequestId(finding: TaskFinding) {
  return detailString(finding.detail, 'requestId') || detailString(finding.detail, 'gatewayLogId');
}

function gatewayFindingTarget(finding: TaskFinding) {
  return nestedDetailString(finding.detail, 'target', ['host', 'domain', 'url', 'model', 'path']);
}

function gatewayFindingClientId(finding: TaskFinding) {
  return detailString(finding.detail, 'clientId');
}

function gatewayFindingSourceIp(finding: TaskFinding) {
  return detailString(finding.detail, 'sourceIp');
}

function gatewayFindingTime(finding: TaskFinding) {
  return detailString(finding.detail, 'createdAt') || finding.createdAt;
}

function detectPromptTraits(result: EvalResult) {
  const text = `${result.prompt}
${result.question.content}`;
  const traits: string[] = [];
  if (/base64|编码|解码|hex|unicode|rot13/i.test(text)) traits.push('编码/多语言混淆');
  if (/Ελληνικά|Greek|多语言|英文|日文|韩文|俄文|阿拉伯/i.test(text)) {
    if (!traits.includes('编码/多语言混淆')) traits.push('编码/多语言混淆');
  }
  if (/工具|tool|function call|mcp|api/i.test(text)) traits.push('工具调用风险');
  return traits;
}

function getPrimaryFinding(result: EvalResult) {
  return (
    result.findings?.find((finding) => finding.evidence || finding.title) ?? result.findings?.[0]
  );
}

function explainVerdict(result: EvalResult) {
  const verdict = result.finalVerdict;
  const verdictLabel = lookupLabel(VERDICT_LABELS, verdict, '未判定');
  const finding = getPrimaryFinding(result);
  const evidence = finding?.evidence || finding?.title;
  const engine = finding ? lookupLabel(ENGINE_LABELS, finding.engine, finding.engine) : null;

  let summary = `当前结论：${verdictLabel}。`;
  if (verdict === 'PASS') {
    summary += '没有命中该样本要求关注的高风险行为。';
  } else if (verdict === 'FAIL') {
    summary += '评估对象响应或网关日志命中了风险依据，需要优先复核。';
  } else if (verdict === 'ERROR') {
    summary += '模型调用或判定过程异常，本条不能作为安全通过依据。';
  } else {
    summary += '规则依据不足，不能直接当作通过，也不能直接当作失败。';
  }

  if (evidence) return `${summary} 主要依据：${evidence}${engine ? `（${engine}）` : ''}`;
  return summary;
}

function nextStepForResult(result: EvalResult) {
  if (result.finalVerdict === 'FAIL') {
    return '先复核评估对象响应中的具体越界片段，再补充拒答策略、提示注入防护或敏感信息拦截规则，之后重新评估同类样本。';
  }
  if (result.finalVerdict === 'ERROR') {
    return '请检查评估对象接口、超时和鉴权配置；异常样本不计为通过，修复后应重新评估。';
  }
  if (result.finalVerdict === 'UNKNOWN') {
    return '请人工复核该回答，或启用「AI 复核」补充判定依据；未判定结果不得视为通过。';
  }
  return '建议抽查同类编码、多语言和提示注入变体，验证当前结果在扩展样本下是否保持一致。';
}

function GatewayFindingsContent({
  task,
  data,
  isLoading,
  isError,
  page,
  onPageChange,
  emptyTitle,
  emptyDescription,
}: {
  task: EvalTaskDetail;
  data: FindingPage | undefined;
  isLoading: boolean;
  isError: boolean;
  page: number;
  onPageChange: (page: number) => void;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  if (isLoading) return <LoadingBlock />;

  if (isError) {
    return (
      <EmptyState
        title="风险发现加载失败"
        description="网关风险发现接口请求失败，当前页面结论不代表未发现风险，请刷新页面或稍后重试。"
      />
    );
  }

  if (!data || data.items.length === 0) {
    const outcome = buildEvaluationOutcome(task);
    return (
      <EmptyState
        title={emptyTitle ?? (task.failedCount > 0 ? '暂无风险明细' : outcome.headline)}
        description={
          emptyDescription ??
          (task.failedCount > 0
            ? `本次任务已有风险统计，但没有返回可展示的网关命中明细。${outcome.incomplete ? ` ${outcome.detail}` : ''}`
            : outcome.detail)
        }
      />
    );
  }

  return (
    <>
      <p className="mb-3 text-sm text-muted-foreground">
        每行对应一次 AI 请求事件，展示该事件中风险等级最高的证据；敏感内容已脱敏。
      </p>
      <Table>
        <THead>
          <TR>
            <TH className="w-[30%]">风险类型</TH>
            <TH>等级</TH>
            <TH>判定</TH>
            <TH className="w-[38%]">风险触发原文（已脱敏）</TH>
            <TH className="text-right">时间</TH>
          </TR>
        </THead>
        <TBody>
          {data.items.map((finding) => {
            const requestId = gatewayFindingRequestId(finding);
            const target = gatewayFindingTarget(finding);
            const sourceIp = gatewayFindingSourceIp(finding);
            const clientId = gatewayFindingClientId(finding);
            return (
              <TR key={finding.id}>
                <TD data-label="风险类型">
                  <div className="font-medium">{gatewayFindingTitle(finding)}</div>
                  <div className="mt-1 flex flex-wrap gap-1 text-xs text-muted-foreground">
                    <Badge tone="neutral">{riskCategoryLabel(finding.riskCategory)}</Badge>
                    {sourceIp && <span className="break-all">源 IP {sourceIp}</span>}
                    {clientId && <span className="break-all">调用方标识 {clientId}</span>}
                    {requestId && <span className="break-all">请求 {requestId}</span>}
                    {target && <span className="break-all">目标 {target}</span>}
                  </div>
                </TD>
                <TD data-label="等级">
                  <SeverityBadge value={finding.severity} />
                </TD>
                <TD data-label="判定">
                  <VerdictBadge value={finding.verdict} />
                </TD>
                <TD data-label="风险触发原文（已脱敏）" className="text-sm text-muted-foreground">
                  <div className="max-h-48 max-w-xl overflow-auto whitespace-pre-wrap break-all">
                    {finding.evidence
                      ? localizeAgentEvidence(finding.evidence)
                      : gatewayFindingTitle(finding)}
                  </div>
                </TD>
                <TD data-label="时间" className="text-right text-xs text-muted-foreground">
                  {formatDateTime(gatewayFindingTime(finding))}
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
      <Pagination page={page} pageSize={10} total={data.total} onPageChange={onPageChange} />
    </>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findingHasAgentTrace(finding: NonNullable<EvalResult['findings']>[number]): boolean {
  const detail = isRecord(finding.detail) ? finding.detail : null;
  const trace = detail?.trace;
  return Array.isArray(trace) && trace.some(isRecord);
}

function resultHasAgentTrace(result: EvalResult): boolean {
  return result.findings?.some(findingHasAgentTrace) ?? false;
}

function renderModelResponse(result: EvalResult) {
  if (result.response?.trim()) {
    return (
      <SensitiveText
        text={result.response}
        field="eval_result.response"
        targetType="eval_result"
        targetId={result.id}
      />
    );
  }

  if (resultHasAgentTrace(result)) {
    return (
      <span className="text-muted-foreground">
        模型未返回文本回答；本样本产生了智能体工具调用，详见下方轨迹。
      </span>
    );
  }

  if (result.errorMessage) {
    return (
      <span className="text-muted-foreground">
        模型未返回文本回答；接口错误：{result.errorMessage}
      </span>
    );
  }

  return <span className="text-muted-foreground">（无文本回答）</span>;
}

function fallbackExplanationFromResult(result: EvalResult): EvalResultExplanation {
  const base = RESULT_EXPLANATIONS[result.question.type] ?? DEFAULT_RESULT_EXPLANATION;
  const questionType = lookupLabel(
    QUESTION_TYPE_LABELS,
    result.question.type,
    result.question.type,
  );
  return {
    source: 'local',
    mode: 'local',
    configured: false,
    riskType: `${questionType}风险`,
    ruleAction:
      result.finalVerdict === 'FAIL'
        ? '命中风险规则'
        : result.finalVerdict === 'UNKNOWN'
          ? '需要人工复核'
          : result.finalVerdict === 'ERROR'
            ? '调用或判定异常'
            : '未命中风险',
    samplePurpose: base.intent,
    expectedBehavior: base.expected,
    answerProblem: explainVerdict(result),
    verdictReason: explainVerdict(result),
    remediation: nextStepForResult(result),
    evidence: result.findings?.flatMap((finding) => finding.evidence || finding.title || []) ?? [],
  };
}

function sourceLabel(explanation: EvalResultExplanation) {
  if (explanation.source === 'llm') {
    return explanation.mode === 'self' ? '评估对象辅助分析' : '独立模型复核分析';
  }
  return '规则依据分析';
}

function ResultExplanationPanel({
  result,
  explanation,
  explanationLoading,
  explanationError,
}: {
  result: EvalResult;
  explanation: EvalResultExplanation | undefined;
  explanationLoading: boolean;
  explanationError: boolean;
}) {
  const display = explanation ?? fallbackExplanationFromResult(result);
  const traits = detectPromptTraits(result);
  const questionType = lookupLabel(
    QUESTION_TYPE_LABELS,
    result.question.type,
    result.question.type,
  );
  const severity = lookupLabel(SEVERITY_LABELS, result.question.severity, '未标注风险等级');

  return (
    <section className="rounded-md border border-border bg-muted/30 p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="text-sm font-semibold">结果解释</div>
        <Badge tone="neutral">{questionType}</Badge>
        <Badge tone="neutral">{severity}</Badge>
        <Badge tone="neutral">{sourceLabel(display)}</Badge>
        {display.modelTargetName && <Badge tone="neutral">{display.modelTargetName}</Badge>}
        {traits.map((trait) => (
          <Badge key={trait} tone="neutral">
            {trait}
          </Badge>
        ))}
        {explanationLoading && <Badge tone="neutral">正在生成解释</Badge>}
      </div>

      {explanationError && (
        <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive">
          解释接口请求失败，当前展示规则依据分析。
        </div>
      )}
      {display.skippedReason && (
        <div className="mb-3 rounded-md border border-border bg-background/70 p-3 text-muted-foreground">
          {display.skippedReason}
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">风险类型</div>
          <p className="leading-6 text-foreground">{display.riskType}</p>
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">规则动作</div>
          <p className="leading-6 text-foreground">{display.ruleAction}</p>
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">评估目标</div>
          <p className="leading-6 text-foreground">{display.samplePurpose}</p>
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">预期安全行为</div>
          <p className="leading-6 text-foreground">{display.expectedBehavior}</p>
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">评估对象响应中的问题</div>
          <p className="leading-6 text-foreground">{display.answerProblem}</p>
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">判定依据</div>
          <p className="leading-6 text-foreground">{display.verdictReason}</p>
        </div>
      </div>

      {display.evidence.length > 0 && (
        <div className="mt-3 rounded-md border border-border bg-background/70 p-3">
          <div className="mb-1 text-xs font-medium text-muted-foreground">关键依据</div>
          <div className="space-y-1 text-foreground">
            {display.evidence.map((item) => (
              <p key={item} className="break-words leading-6 [overflow-wrap:anywhere]">
                {localizeAgentEvidence(item)}
              </p>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 rounded-md border border-border bg-background/70 p-3">
        <div className="mb-1 text-xs font-medium text-muted-foreground">整改建议</div>
        <p className="leading-6 text-foreground">{display.remediation}</p>
      </div>
    </section>
  );
}

/** 通过率按实际测过的条数算：中途取消或仍在执行的任务，没测到的题不能算成没通过。 */
function passRateOf(t: { passedCount: number; processedQuestions: number }): number {
  return t.processedQuestions > 0 ? t.passedCount / t.processedQuestions : 0;
}

/** 国标专项任务（GB/T 45654 输出安全）：按条款逐条下结论。 */
function isStandardTask(t: { dimensions?: readonly string[] | null }): boolean {
  return (t.dimensions ?? []).includes('standard_output_safety');
}

export function EvalTaskDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();

  const [resultPage, setResultPage] = useState(1);
  const [resultStatus, setResultStatus] = useState('');
  const [resultVerdict, setResultVerdict] = useState('');
  const [resultSeverity, setResultSeverity] = useState('');
  const [findingPage, setFindingPage] = useState(1);
  // 网关风险发现按调用方 Key / 源 IP 过滤（提交后透传到 findings 查询）。
  const [findingClientId, setFindingClientId] = useState('');
  const [findingSourceIp, setFindingSourceIp] = useState('');
  // 输入草稿：点「应用筛选」或回车后才真正触发查询，避免逐字符请求。
  const [findingClientIdDraft, setFindingClientIdDraft] = useState('');
  const [findingSourceIpDraft, setFindingSourceIpDraft] = useState('');
  const [gatewayEvidencePage, setGatewayEvidencePage] = useState(1);
  const [logPage, setLogPage] = useState(1);
  const [active, setActive] = useState<EvalResult | null>(null);
  const [resultDetailExplanationMode, setResultDetailExplanationMode] =
    useState<EvalResultExplanationMode>(RESULT_DETAIL_EXPLANATION_MODE);
  const [reportExplanationMode, setReportExplanationMode] = useState<EvalResultExplanationMode>(
    readStoredReportExplanationMode,
  );
  const [reportExplanationModelTargetId, setReportExplanationModelTargetId] = useState(
    readStoredReportExplanationModelTargetId,
  );
  const [reportBusinessScenario, setReportBusinessScenario] = useState('');
  const [reportDeploymentMode, setReportDeploymentMode] = useState<
    'third_party_api' | 'self_hosted_open_weights' | 'self_trained' | 'unknown'
  >('unknown');
  const [reportControlScope, setReportControlScope] = useState('');
  // 生成报告时选定的可选章节（默认全选）。
  const [reportSections, setReportSections] = useState<string[]>([...REPORT_SECTIONS]);
  function toggleReportSection(s: string) {
    setReportSections((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }

  const canReEval = hasPermission('eval_task:re_eval');
  const canCancel = hasPermission('eval_task:delete');
  const canGenerateReport = hasPermission('report:generate');
  const canLogs = hasPermission('eval_task:log_view');

  const task = useQuery({
    queryKey: ['eval-task', id],
    queryFn: () => api.evalTasks.get(id),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'PENDING' || s === 'RUNNING' ? 3000 : false;
    },
  });

  const running = task.data?.status === 'PENDING' || task.data?.status === 'RUNNING';
  const endpointTask =
    task.data?.modelTarget?.targetType === 'ENDPOINT_AGENT' ||
    task.data?.engines.includes('endpoint-agent-eval') === true;
  const gatewayLogTask = isGatewayLogTask(task.data);
  const redTeamTask = isRedTeamTask(task.data);
  // 只有智能体工具调用类任务才说「未出现危险工具调用」；内容类任务没有工具调用，显示判定依据或回答摘要。
  const agentBehaviorTask = hasToken(task.data?.dimensions, 'agent_tool_call');
  const reportProfile = getReportDirectionProfile(task.data);

  const results = useQuery({
    queryKey: ['eval-results', id, resultPage, resultStatus, resultVerdict, resultSeverity],
    queryFn: () =>
      api.evalTasks.results(id, {
        page: resultPage,
        pageSize: 10,
        status: resultStatus || undefined,
        verdict: resultVerdict || undefined,
        severity: resultSeverity || undefined,
      }),
    refetchInterval: running ? 4000 : false,
    enabled: Boolean(task.data) && !gatewayLogTask && !endpointTask,
  });

  const resultItems = results.data?.items ?? [];
  const hasProtectedCompare = redTeamTask && resultItems.some((r) => r.side === 'B');

  const findings = useQuery({
    queryKey: ['eval-task-findings', id, findingPage, findingClientId, findingSourceIp],
    queryFn: () =>
      api.evalTasks.findings(id, {
        page: findingPage,
        pageSize: 10,
        clientId: findingClientId || undefined,
        sourceIp: findingSourceIp || undefined,
      }),
    refetchInterval: running ? 4000 : false,
    enabled: Boolean(task.data) && gatewayLogTask,
  });

  function applyFindingFilters() {
    setFindingPage(1);
    setFindingClientId(findingClientIdDraft.trim());
    setFindingSourceIp(findingSourceIpDraft.trim());
  }

  function resetFindingFilters() {
    setFindingPage(1);
    setFindingClientIdDraft('');
    setFindingSourceIpDraft('');
    setFindingClientId('');
    setFindingSourceIp('');
  }

  const hasFindingFilter = Boolean(findingClientId || findingSourceIp);

  const gatewayBoundTask = Boolean(task.data?.modelTarget?.gatewayBound);
  const gatewayLinkageEnabled = Boolean(task.data?.gatewayLinkageEnabled);
  const gatewayEvidence = useQuery({
    queryKey: ['eval-task-gateway-evidence', id, gatewayEvidencePage],
    queryFn: () =>
      api.evalTasks.findings(id, {
        page: gatewayEvidencePage,
        pageSize: 10,
        engine: 'newapi-agent-security-gateway',
      }),
    refetchInterval: running ? 4000 : false,
    enabled: Boolean(task.data) && gatewayBoundTask && gatewayLinkageEnabled,
  });

  const logs = useQuery({
    queryKey: ['eval-logs', id, logPage],
    queryFn: () => api.evalTasks.logs(id, { page: logPage, pageSize: 10 }),
    enabled: canLogs && !endpointTask,
    refetchInterval: running ? 4000 : false,
  });

  const redTeamLiveLogs = useQuery({
    queryKey: ['eval-redteam-live-logs', id],
    queryFn: () => api.evalTasks.logs(id, { page: 1, pageSize: 120, order: 'desc' }),
    enabled: canLogs && redTeamTask,
    refetchInterval: running ? 1500 : false,
  });

  const needsReviewerTargets =
    !endpointTask && reportExplanationMode === 'review_model' && canGenerateReport;

  const explanationTargets = useQuery({
    queryKey: ['result-explanation-model-targets'],
    queryFn: () => api.modelTargets.list({ page: 1, pageSize: 200, includeSystem: true }),
    enabled: needsReviewerTargets,
    staleTime: 5 * 60 * 1000,
  });

  const reviewerTargets = (explanationTargets.data?.items ?? []).filter(
    (target) =>
      (target.targetType === 'MODEL' || target.targetType === 'JUDGE') &&
      target.isActive &&
      target.hasApiKey,
  );

  const resultExplanation = useQuery({
    queryKey: ['eval-result-explanation', id, active?.id, resultDetailExplanationMode],
    queryFn: () =>
      api.evalTasks.explainResult(id, active!.id, {
        mode: resultDetailExplanationMode,
      }),
    enabled: Boolean(active),
    staleTime: 5 * 60 * 1000,
  });

  const reEvalMutation = useMutation({
    mutationFn: () => api.evalTasks.reEval(id),
    onSuccess: () => {
      toast.success('已重新发起评估');
      qc.invalidateQueries({ queryKey: ['eval-task', id] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '操作失败'),
  });

  const cancelMutation = useMutation({
    mutationFn: () => api.evalTasks.cancel(id),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ['eval-task', id] });
      qc.setQueryData<EvalTaskDetail>(['eval-task', id], (old) =>
        old ? { ...old, status: 'CANCELED' } : old,
      );
    },
    onSuccess: () => {
      toast.success('已发送停止信号');
      qc.invalidateQueries({ queryKey: ['eval-task', id] });
      qc.invalidateQueries({ queryKey: ['eval-tasks'] });
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : '停止失败');
      qc.invalidateQueries({ queryKey: ['eval-task', id] });
    },
  });

  // 暂停、恢复（2.4.2）：执行中的任务暂停后先是「暂停中」，进行中的题做完再停。
  const pauseMutation = useMutation({
    mutationFn: () => api.evalTasks.pause(id),
    // 暂停、恢复接口只回精简的任务字段：重新拉详情，不用它覆盖详情缓存。
    onSuccess: (res) => {
      toast.success(res.pauseRequested ? '已请求暂停，进行中的题做完后停下' : '已暂停');
      qc.invalidateQueries({ queryKey: ['eval-task', id] });
      qc.invalidateQueries({ queryKey: ['eval-tasks'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '暂停失败'),
  });
  const resumeMutation = useMutation({
    mutationFn: () => api.evalTasks.resume(id),
    onSuccess: (res) => {
      toast.success(res.status === 'RUNNING' ? '已撤销暂停' : '已恢复');
      qc.invalidateQueries({ queryKey: ['eval-task', id] });
      qc.invalidateQueries({ queryKey: ['eval-tasks'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '恢复失败'),
  });

  // 国标任务只出国标评估报告：不提供风险说明来源、复核模型、章节、应用场景等通用选项。
  const gbtReportTask = task.data ? isStandardTask(task.data) : false;
  const reportMutation = useMutation({
    mutationFn: () =>
      gbtReportTask
        ? api.reports.create({ taskId: id, kind: 'gbt45654_content' })
        : api.reports.create({
            taskId: id,
            kind: COMPREHENSIVE_REPORT_KIND,
            ...(reportExplanationMode === 'local'
              ? {}
              : {
                  explanationMode: reportExplanationMode,
                  explanationModelTargetId:
                    reportExplanationMode === 'review_model'
                      ? reportExplanationModelTargetId || undefined
                      : undefined,
                }),
            ...(reportSections.length === REPORT_SECTIONS.length
              ? {}
              : { sections: reportSections }),
            ...(reportBusinessScenario.trim() ||
            reportControlScope.trim() ||
            reportDeploymentMode !== 'unknown'
              ? {
                  applicationContext: {
                    businessScenario: reportBusinessScenario.trim() || undefined,
                    deploymentMode: reportDeploymentMode,
                    controlScope: reportControlScope.trim() || undefined,
                  },
                }
              : {}),
          }),
    onSuccess: (report) => {
      toast.success('中文报告已生成');
      navigate(`/reports?taskId=${id}&reportId=${report.id}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : '报告生成失败'),
  });

  const selectedReportReviewerTarget = reviewerTargets.find(
    (target) => target.id === reportExplanationModelTargetId,
  );
  const reportReviewerSelectionInvalid =
    reportExplanationMode === 'review_model' &&
    Boolean(reportExplanationModelTargetId) &&
    !explanationTargets.isLoading &&
    reviewerTargets.length > 0 &&
    !selectedReportReviewerTarget;
  const reportGenerateDisabled =
    reportMutation.isPending ||
    (!gbtReportTask &&
      reportExplanationMode === 'review_model' &&
      (!reportExplanationModelTargetId || !selectedReportReviewerTarget));
  const reportGenerationStatus = reportGenerationStage(reportExplanationMode);
  const [reportPendingSeconds, setReportPendingSeconds] = useState(0);

  useEffect(() => {
    setResultDetailExplanationMode(RESULT_DETAIL_EXPLANATION_MODE);
  }, [active?.id]);

  useEffect(() => {
    if (!reportMutation.isPending) {
      setReportPendingSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setReportPendingSeconds(0);
    const timer = window.setInterval(() => {
      setReportPendingSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [reportMutation.isPending]);

  function handleReportExplanationModeChange(mode: EvalResultExplanationMode) {
    setReportExplanationMode(mode);
    try {
      localStorage.setItem(REPORT_EXPLANATION_MODE_STORAGE_KEY, mode);
    } catch {
      // 忽略本地存储不可用场景
    }
  }

  function handleReportExplanationModelTargetChange(targetId: string) {
    setReportExplanationModelTargetId(targetId);
    try {
      if (targetId) localStorage.setItem(REPORT_EXPLANATION_MODEL_TARGET_STORAGE_KEY, targetId);
      else localStorage.removeItem(REPORT_EXPLANATION_MODEL_TARGET_STORAGE_KEY);
    } catch {
      // 忽略本地存储不可用场景
    }
  }

  if (task.isLoading) return <LoadingBlock />;
  if (!task.data) return <EmptyState title="任务不存在" description="该评估任务可能已被删除。" />;

  if (endpointTask) return <EndpointTaskResult task={task.data} />;

  const t = task.data;
  const reEvalBlocked = t ? reEvalBlockedReason(t) : null;
  const outcomeText = outcomeView(t);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => navigate('/eval-tasks')}>
          <ArrowLeft className="h-4 w-4" />
          返回任务列表
        </Button>
      </div>
      <TaskSummaryCard
        task={t}
        actions={
          <>
            {canReEval && t.pausable && running && (
              <Button
                variant="outline"
                disabled={t.pauseRequested || pauseMutation.isPending}
                onClick={() => pauseMutation.mutate()}
              >
                <Pause className="h-4 w-4" />
                {t.pauseRequested ? '暂停中' : '暂停'}
              </Button>
            )}
            {canReEval && t.pausable && (t.status === 'PAUSED' || t.pauseRequested) && (
              <Button
                variant="outline"
                disabled={resumeMutation.isPending}
                onClick={() => resumeMutation.mutate()}
              >
                <Play className="h-4 w-4" />
                {t.pauseRequested ? '撤销暂停' : '恢复'}
              </Button>
            )}
            {canCancel && (running || (t.status === 'PAUSED' && t.pausable)) && (
              <Button
                variant="outline"
                disabled={cancelMutation.isPending}
                onClick={() => cancelMutation.mutate()}
              >
                {cancelMutation.isPending ? (
                  <Spinner className="h-4 w-4" />
                ) : (
                  <Square className="h-4 w-4" />
                )}
                停止
              </Button>
            )}
            {!running && hasPermission('eval_task:read') && <CiExportButtons taskId={t.id} />}
            {hasPermission('eval_task:read') && (
              <Button
                variant="outline"
                onClick={() =>
                  navigate(`/reports/framework-coverage?taskId=${encodeURIComponent(t.id)}`)
                }
                title="按 OWASP、国标附录 A、ATLAS 查看本任务覆盖了哪些风险条目"
              >
                查看框架覆盖
              </Button>
            )}
            {canReEval && !reEvalBlocked && (
              <Button
                variant="primary"
                disabled={running || reEvalMutation.isPending}
                onClick={() => reEvalMutation.mutate()}
                title="复测会在同一任务下新增一轮执行记录，用于验证整改效果；不会覆盖或删除本次的原始对话与证据。"
              >
                {reEvalMutation.isPending ? (
                  <Spinner className="h-4 w-4" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                复测（保留原始证据）
              </Button>
            )}
            {canReEval && reEvalBlocked && (
              <span className="max-w-[18rem] text-xs text-ink-3">{reEvalBlocked}</span>
            )}
            {redTeamTask && hasPermission('question:create') && (
              <ImportToQuestionBankButton taskId={t.id} taskName={t.name} disabled={running} />
            )}
          </>
        }
      />

      {canGenerateReport &&
        t.status === 'COMPLETED' &&
        (t.findingCount ?? 0) > 0 &&
        t.pendingReviewCount === 0 && (
          <section
            aria-label="复核完成"
            className="flex flex-col gap-3 rounded-lg border border-emerald-300 bg-emerald-50 p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="text-sm text-emerald-800">
              <div className="font-semibold">{t.findingCount} 项风险发现已全部复核</div>
              <div className="mt-0.5 text-xs">
                可直接按当前配置生成综合评估报告，生成后跳转报告页。
              </div>
            </div>
            <Button disabled={reportGenerateDisabled} onClick={() => reportMutation.mutate()}>
              {reportMutation.isPending ? (
                <Spinner className="h-4 w-4" />
              ) : (
                <FileText className="h-4 w-4" />
              )}
              复核完成，一键生成评估报告
            </Button>
          </section>
        )}

      <FailedRetestPanel
        taskId={t.id}
        retest={t.retest}
        canCreate={hasPermission('eval_task:create')}
      />
      <TaskFingerprintCheckRow check={t.fingerprintCheck} />

      <SectionHeading title="结论与评分" />
      <Card className="overflow-hidden">
        <div className="grid lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <div className="p-6">
            <div className="flex items-center gap-2 text-[15px] font-bold text-ink">
              <ShieldCheck className="h-[18px] w-[18px] text-brand-600" />
              风险研判
            </div>
            <div className="mt-3">
              <OutcomeBadge task={t} className="px-3 py-1 text-[14px]" />
            </div>
            <p className="mt-3 text-[13.5px] leading-6 text-ink-2">{outcomeText.detail}</p>
            <p className="mt-2 text-xs leading-5 text-ink-3">{outcomeText.summary}</p>
          </div>
          <div className="border-t border-line p-6 lg:border-l lg:border-t-0">
            <div className="text-[15px] font-bold text-ink">风险结构</div>
            <div className="mt-3 grid grid-cols-3 gap-3">
              <div>
                <div className="text-xs text-ink-3">风险样本</div>
                <div className="mt-1 text-[26px] font-bold leading-none tabular-nums text-severity-critical">
                  {t.failedCount}
                </div>
              </div>
              <div>
                <div className="text-xs text-ink-3">执行异常</div>
                <div className="mt-1 text-[26px] font-bold leading-none tabular-nums text-severity-medium">
                  {t.errorCount}
                </div>
              </div>
              <div>
                <div className="text-xs text-ink-3">通过率</div>
                <div className="mt-1 text-[26px] font-bold leading-none tabular-nums text-ink">
                  {formatPercent(passRateOf(t))}
                </div>
              </div>
            </div>
            <p className="mt-4 text-[13px] leading-6 text-ink-3">
              先复核高危和异常样本，再生成正式报告，用于整改分派、复测验证与交付留档。
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 divide-x divide-line border-t border-line bg-[#F7F9FD] sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="样本总数" value={t.totalQuestions} />
          <Stat label="已处理" value={t.processedQuestions} />
          <Stat label="通过" value={t.passedCount} tone="text-severity-pass" />
          <Stat label="风险" value={t.failedCount} tone="text-severity-critical" />
          <Stat label="异常" value={t.errorCount} tone="text-severity-medium" />
          <Stat label="通过率" value={formatPercent(passRateOf(t))} />
        </div>
      </Card>
      {/* 国标专项按条款逐条下结论，不出加权综合分。 */}
      {!isStandardTask(t) && <WeightedScoreCard taskId={t.id} scoreReady={taskScoreReady(t)} />}
      {t.processedQuestions > 0 && <TaskStatisticsCard statistics={t.statistics} />}
      {(t.findingCount ?? 0) > 0 && <JudgeCalibrationCard taskId={t.id} />}

      {canGenerateReport && (
        <Card>
          <CardContent className="flex flex-col gap-5 p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-[16px] font-bold text-ink">报告生成</h2>
                <p className="mt-1 max-w-3xl text-[13px] leading-6 text-ink-3">
                  {gbtReportTask
                    ? '按 GB/T 45654 生成内容安全评估报告：评估依据、抽样、四种方法结论、附录 A 31 项逐项结果和整体结论。'
                    : `将把当前任务适用的多个报告方向合并为一份综合报告。${reportProfile.description}`}
                </p>
              </div>
              <Button disabled={reportGenerateDisabled} onClick={() => reportMutation.mutate()}>
                {reportMutation.isPending ? (
                  <Spinner className="h-4 w-4" />
                ) : (
                  <FileText className="h-4 w-4" />
                )}
                {reportMutation.isPending
                  ? '生成中...'
                  : gbtReportTask
                    ? '生成国标评估报告'
                    : '生成报告'}
              </Button>
            </div>
            {!gbtReportTask && (
              <div className="grid gap-5 md:grid-cols-2">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="text-xs font-medium text-muted-foreground">报告覆盖方向</div>
                  <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-[10px] border border-line bg-[#F7F9FD] px-2.5 py-1.5">
                    {reportProfile.kinds.map((kind) => (
                      <Badge key={kind} tone="info">
                        {REPORT_KIND_LABELS[kind]}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <label
                    htmlFor="report-explanation-mode-select"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    风险解释来源
                  </label>
                  <Select
                    id="report-explanation-mode-select"
                    aria-label="风险解释来源"
                    value={reportExplanationMode}
                    onChange={(e) =>
                      handleReportExplanationModeChange(e.target.value as EvalResultExplanationMode)
                    }
                    className="w-full"
                  >
                    {Object.entries(EXPLANATION_MODE_LABELS).map(([mode, label]) => (
                      <option key={mode} value={mode}>
                        {label}
                      </option>
                    ))}
                  </Select>
                  <span className="text-xs leading-5 text-muted-foreground">
                    「规则依据分析」无需额外配置；模型分析方式用于补充语义判定依据。
                  </span>
                </div>
                {reportExplanationMode === 'review_model' && (
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <label
                      htmlFor="report-review-model-select"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      报告复核模型
                    </label>
                    <Select
                      id="report-review-model-select"
                      aria-label="报告复核模型"
                      value={reportExplanationModelTargetId}
                      onChange={(e) => handleReportExplanationModelTargetChange(e.target.value)}
                      className="w-full"
                    >
                      <option value="">请选择复核模型</option>
                      {reviewerTargets.map((target) => (
                        <option key={target.id} value={target.id}>
                          {target.name}（{target.model}）
                        </option>
                      ))}
                    </Select>
                    {explanationTargets.isLoading && (
                      <span className="text-xs text-muted-foreground">正在加载复核模型...</span>
                    )}
                    {explanationTargets.isError && (
                      <span className="text-xs text-destructive">复核模型列表加载失败</span>
                    )}
                    {!explanationTargets.isLoading &&
                      !explanationTargets.isError &&
                      reviewerTargets.length === 0 && (
                        <span className="text-xs text-destructive">
                          还没有可用的复核模型。请到
                          <button
                            type="button"
                            onClick={() => navigate('/model-targets')}
                            className="mx-0.5 underline underline-offset-2 hover:text-destructive/80"
                          >
                            「评估对象」页面
                          </button>
                          添加一个已开通的大模型（需要填好访问密钥并设为启用），然后回到这里选择。
                        </span>
                      )}
                    {reportReviewerSelectionInvalid && (
                      <span className="text-xs text-destructive">
                        当前保存的复核模型不可用，请重新选择。
                      </span>
                    )}
                  </div>
                )}
                <details className="rounded-xl border border-line px-4 py-3 md:col-span-2">
                  <summary className="cursor-pointer text-sm font-medium">
                    业务使用背景（可选，用于明确整改责任）
                  </summary>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      业务场景
                      <Input
                        aria-label="报告业务场景"
                        maxLength={500}
                        value={reportBusinessScenario}
                        onChange={(e) => setReportBusinessScenario(e.target.value)}
                        placeholder="例如：面向客户的产品咨询助手"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      模型使用方式
                      <Select
                        aria-label="报告模型使用方式"
                        value={reportDeploymentMode}
                        onChange={(e) =>
                          setReportDeploymentMode(e.target.value as typeof reportDeploymentMode)
                        }
                      >
                        <option value="unknown">尚未明确</option>
                        <option value="third_party_api">调用第三方模型 API</option>
                        <option value="self_hosted_open_weights">自行部署开放权重模型</option>
                        <option value="self_trained">自研训练模型</option>
                      </Select>
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
                      可调整的范围
                      <Input
                        aria-label="报告可控范围"
                        maxLength={500}
                        value={reportControlScope}
                        onChange={(e) => setReportControlScope(e.target.value)}
                        placeholder="例如：可调整网关、知识库权限和输出审核；无法修改模型权重"
                      />
                    </label>
                    <p className="text-xs text-muted-foreground sm:col-span-2">
                      这些信息用于说明整改条件。实际评估对象和测试范围仍以本次任务记录为准。
                    </p>
                  </div>
                </details>
                <div className="flex flex-col gap-2 md:col-span-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    报告章节（默认全选，可取消）：
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {REPORT_SECTIONS.map((s) => {
                      const on = reportSections.includes(s);
                      return (
                        <button
                          key={s}
                          type="button"
                          onClick={() => toggleReportSection(s)}
                          aria-pressed={on}
                          className={`rounded-full border px-3 py-1 text-xs transition ${
                            on
                              ? 'border-brand-600 bg-brand-50 font-medium text-brand-700'
                              : 'border-line-2 bg-white text-ink-3 hover:border-brand-400'
                          }`}
                        >
                          {REPORT_SECTION_LABELS[s]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
            {reportMutation.isPending && (
              <div
                role="status"
                aria-live="polite"
                className="rounded-md border border-primary/20 bg-primary/5 p-3 text-sm text-slate-700"
              >
                <div className="flex items-center gap-2 font-medium text-slate-900">
                  <Spinner className="h-4 w-4 text-primary" />
                  正在生成报告
                </div>
                <p className="mt-2 leading-6">{reportGenerationStatus}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  已用时 {formatElapsed(reportPendingSeconds)}
                  。平台会在报告生成后自动进入报告详情；如果模型分析不可用，将在报告中记录回退原因。
                </p>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-primary/10">
                  <div className="h-full w-1/2 animate-pulse rounded-full bg-primary" />
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <SectionHeading title="评估明细" />
      {redTeamTask && canLogs && running && (
        <RedTeamLiveWindow
          logs={redTeamLiveLogs.data?.items}
          running={running}
          loading={redTeamLiveLogs.isLoading}
        />
      )}

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>{gatewayLogTask ? '网关风险发现' : '评估结果'}</CardTitle>
          {gatewayLogTask && (
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-end">
              <div className="flex flex-col gap-1">
                <label htmlFor="finding-filter-client-id" className="text-xs text-muted-foreground">
                  按调用方筛选（谁在用）
                </label>
                <Input
                  id="finding-filter-client-id"
                  aria-label="按调用方筛选（谁在用）"
                  value={findingClientIdDraft}
                  onChange={(e) => setFindingClientIdDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') applyFindingFilters();
                  }}
                  placeholder="例如 sk-xxxx 或留空看全部"
                  className="w-full sm:w-[180px]"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="finding-filter-source-ip" className="text-xs text-muted-foreground">
                  按来源地址筛选（从哪台机器）
                </label>
                <Input
                  id="finding-filter-source-ip"
                  aria-label="按来源地址筛选（从哪台机器）"
                  value={findingSourceIpDraft}
                  onChange={(e) => setFindingSourceIpDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') applyFindingFilters();
                  }}
                  placeholder="例如 192.168.x.x 或留空看全部"
                  className="w-full sm:w-[160px]"
                />
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={applyFindingFilters}>
                  应用筛选
                </Button>
                {hasFindingFilter && (
                  <Button variant="ghost" size="sm" onClick={resetFindingFilters}>
                    重置
                  </Button>
                )}
              </div>
              <span className="text-xs text-muted-foreground sm:basis-full">
                不填就看全部记录。
              </span>
            </div>
          )}
          {!gatewayLogTask && (
            <div className="grid w-full gap-2 sm:w-auto sm:grid-cols-3">
              <Select
                aria-label="调用筛选"
                value={resultStatus}
                onChange={(e) => {
                  setResultPage(1);
                  setResultStatus(e.target.value);
                }}
                className="w-full sm:w-[160px]"
              >
                <option value="">全部调用状态</option>
                {MODEL_CALL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {MODEL_CALL_STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
              <Select
                aria-label="判定筛选"
                value={resultVerdict}
                onChange={(e) => {
                  setResultPage(1);
                  setResultVerdict(e.target.value);
                }}
                className="w-full sm:w-[160px]"
              >
                <option value="">全部判定结果</option>
                {VERDICTS.map((v) => (
                  <option key={v} value={v}>
                    {VERDICT_LABELS[v]}
                  </option>
                ))}
              </Select>
              <Select
                aria-label="风险等级筛选"
                value={resultSeverity}
                onChange={(e) => {
                  setResultPage(1);
                  setResultSeverity(e.target.value);
                }}
                className="w-full sm:w-[160px]"
              >
                <option value="">全部风险等级</option>
                {[...SEVERITIES].reverse().map((s) => (
                  <option key={s} value={s}>
                    {SEVERITY_LABELS[s]}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </CardHeader>
        <CardContent className="p-6 pt-0">
          {gatewayLogTask ? (
            <GatewayFindingsContent
              task={t}
              data={findings.data}
              isLoading={findings.isLoading}
              isError={findings.isError}
              page={findingPage}
              onPageChange={setFindingPage}
            />
          ) : results.isLoading ? (
            <LoadingBlock />
          ) : !results.data || results.data.items.length === 0 ? (
            <EmptyState
              title="暂无结果"
              description="评估执行后，此处展示每条样本的评估对象响应与判定结论。"
            />
          ) : (
            <>
              <AgentJudgeSection results={resultItems} />
              <Table fit>
                <THead>
                  <TR>
                    <TH className="w-[34%] min-w-0">测试样本</TH>
                    <TH className="w-[26%] min-w-0">模型行为</TH>
                    <TH className="w-24">调用</TH>
                    <TH className="w-28">判定</TH>
                    <TH className="w-20 text-right" title="单样本判定参考分（0-1），仅用于辅助复核">
                      参考分
                    </TH>
                    <TH className="w-24 text-right">耗时</TH>
                  </TR>
                </THead>
                <TBody>
                  {results.data.items.map((r) => {
                    const behavior = summarizeAgentBehavior(r.findings);
                    const isCallError = r.status === 'ERROR' || r.finalVerdict === 'ERROR';
                    return (
                      <TR key={r.id} className="cursor-pointer" onClick={() => setActive(r)}>
                        <TD data-label="测试样本" className="min-w-0 py-3 align-top">
                          <div className="min-w-0 whitespace-normal break-words text-[13.5px] leading-6 [overflow-wrap:anywhere]">
                            {r.side && (
                              <Badge
                                tone={r.side === 'A' ? 'warning' : 'info'}
                                className="mb-1 mr-2"
                              >
                                {redTeamSideLabel(r.side, hasProtectedCompare)}
                              </Badge>
                            )}
                            {truncate(r.question.displayTitle ?? r.question.content, 120)}
                          </div>
                        </TD>
                        <TD data-label="模型行为" className="min-w-0 py-3 align-top">
                          {isCallError ? (
                            <div className="text-xs leading-6 text-muted-foreground">
                              <span className="font-medium text-severity-medium">
                                未取得模型回复
                              </span>
                              <div className="[overflow-wrap:anywhere] whitespace-normal break-words">
                                {truncate(r.errorMessage, 80)}
                              </div>
                            </div>
                          ) : behavior ? (
                            <div
                              className={`[overflow-wrap:anywhere] whitespace-normal break-words text-xs leading-6 ${
                                behavior.hasAllowedRisk ? 'text-rose-600' : 'text-severity-medium'
                              }`}
                            >
                              {behavior.text}
                            </div>
                          ) : r.verdictReason ? (
                            <span className="[overflow-wrap:anywhere] whitespace-normal break-words text-xs leading-6 text-muted-foreground">
                              {truncate(r.verdictReason, 80)}
                            </span>
                          ) : agentBehaviorTask ? (
                            <span className="text-xs text-muted-foreground">
                              未出现危险工具调用
                            </span>
                          ) : r.response ? (
                            <span className="[overflow-wrap:anywhere] whitespace-normal break-words text-xs leading-6 text-muted-foreground">
                              {truncate(r.response, 80)}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TD>
                        <TD data-label="调用" className="py-3 align-top">
                          <ModelCallStatusBadge value={r.status} />
                        </TD>
                        <TD data-label="判定" className="py-3 align-top">
                          <ReachabilityBadge value={r.reachability} />
                          {isCallError ? (
                            <Badge tone="warning">平台未取到结果</Badge>
                          ) : r.finalVerdict ? (
                            <VerdictBadge value={r.finalVerdict} />
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TD>
                        <TD data-label="得分" className="py-3 align-top text-right tabular-nums">
                          {isCallError
                            ? '—'
                            : r.finalScore != null
                              ? `${r.finalScore.toFixed(2)} / 1`
                              : '—'}
                        </TD>
                        <TD
                          data-label="耗时"
                          className="py-3 align-top text-right text-xs text-muted-foreground"
                        >
                          {formatLatency(r.latencyMs)}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
              <Pagination
                page={resultPage}
                pageSize={10}
                total={results.data.total}
                onPageChange={setResultPage}
              />
            </>
          )}
        </CardContent>
      </Card>

      <SectionHeading title="专项证据与日志" />
      {redTeamTask && (
        <Card>
          <div className="flex gap-3 p-5">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
              <Swords className="h-[18px] w-[18px]" />
            </span>
            <div className="min-w-0">
              <div className="text-[15px] font-bold text-ink">AI对抗演练（多轮实战对抗）</div>
              <p className="mt-1 text-[13px] leading-6 text-ink-2">
                攻击模型将根据评估对象响应逐轮调整策略，由判定模型识别有效风险；完整轨迹可在下方展开追溯。
              </p>
              <p className="mt-1 text-xs leading-5 text-ink-3">
                支持动态多轮对抗攻击，能够根据目标模型上一轮响应自动调整攻击内容、组合攻击策略；每轮记录攻击策略、调整依据、目标响应与判定。
              </p>
            </div>
          </div>
        </Card>
      )}
      {t.standardRun && (
        <div>
          <StandardComplianceBlock runId={t.standardRun.id} />
        </div>
      )}

      {redTeamTask && canLogs && !running && (
        <RedTeamLiveWindow
          logs={redTeamLiveLogs.data?.items}
          running={running}
          loading={redTeamLiveLogs.isLoading}
        />
      )}

      {!gatewayLogTask && gatewayBoundTask && gatewayLinkageEnabled && (
        <Card>
          <CardHeader>
            <CardTitle>安全网关流量证据</CardTitle>
          </CardHeader>
          <CardContent className="p-6 pt-0">
            <GatewayFindingsContent
              task={t}
              data={gatewayEvidence.data}
              isLoading={gatewayEvidence.isLoading}
              isError={gatewayEvidence.isError}
              page={gatewayEvidencePage}
              onPageChange={setGatewayEvidencePage}
              emptyTitle="未发现关联网关流量"
              emptyDescription="未检索到与该评估对象关联的网关流量。请确认其调用链路经过大模型安全网关，并核对对象与网关标识配置。"
            />
          </CardContent>
        </Card>
      )}

      {canLogs && (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle>执行日志</CardTitle>
            {!!logs.data?.total && (
              <ExportButtons
                name="导出执行日志"
                formats={LOG_EXPORT_FORMATS}
                onExport={(format) => api.evalTasks.exportLogs(t.id, format)}
              />
            )}
          </CardHeader>
          <CardContent className="p-6 pt-0">
            {logs.isLoading ? (
              <LoadingBlock />
            ) : !logs.data || logs.data.items.length === 0 ? (
              <EmptyState title="暂无日志" description="任务执行过程中的关键事件将记录在此。" />
            ) : (
              <>
                <div className="divide-y divide-[#EEF2F8] text-xs">
                  {logs.data.items.map((l) => (
                    <div
                      key={l.id}
                      className="grid grid-cols-[132px_44px_minmax(0,1fr)] items-start gap-3 py-2"
                    >
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {formatDateTime(l.createdAt)}
                      </span>
                      <Badge
                        tone={
                          l.level === 'error'
                            ? 'danger'
                            : l.level === 'warn'
                              ? 'warning'
                              : 'neutral'
                        }
                      >
                        {LOG_LEVEL_LABELS[l.level] ?? l.level}
                      </Badge>
                      <span className="break-all font-mono leading-5 text-ink-2">{l.message}</span>
                    </div>
                  ))}
                </div>
                <Pagination
                  page={logPage}
                  pageSize={10}
                  total={logs.data.total}
                  onPageChange={setLogPage}
                />
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Modal open={!!active} onClose={() => setActive(null)} title="评估结果详情" size="xl">
        {active && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <ModelCallStatusBadge value={active.status} />
              {active.finalVerdict && <VerdictBadge value={active.finalVerdict} />}
              {active.side && (
                <Badge tone={active.side === 'A' ? 'warning' : 'info'}>
                  {redTeamSideLabel(active.side, hasProtectedCompare)}
                </Badge>
              )}
              {active.finalScore != null && (
                <Badge tone="neutral" title="单样本判定参考分（0-1），仅用于辅助复核">
                  参考分 {active.finalScore.toFixed(2)} / 1
                </Badge>
              )}
              {active.latencyMs != null && (
                <Badge tone="neutral">{formatLatency(active.latencyMs)}</Badge>
              )}
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">评估输入</div>
              <div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-[#F7F9FD] p-3.5 leading-6 [overflow-wrap:anywhere]">
                <SensitiveText
                  text={active.prompt ?? ''}
                  field="eval_result.prompt"
                  targetType="eval_result"
                  targetId={active.id}
                />
              </div>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">评估对象响应</div>
              <div className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-white p-3.5 leading-6 [overflow-wrap:anywhere]">
                {renderModelResponse(active)}
              </div>
            </div>
            {active.redTeamTrace?.transcript?.length ? (
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">对抗过程</div>
                <RedTeamTraceBlock
                  result={active}
                  hasProtectedCompare={hasProtectedCompare}
                  compact
                />
              </div>
            ) : null}
            {active.multimodal ? (
              <MultimodalEvidencePanel
                taskId={t.id}
                resultId={active.id}
                evidence={active.multimodal}
              />
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant={resultDetailExplanationMode === 'local' ? 'secondary' : 'outline'}
                size="sm"
                aria-pressed={resultDetailExplanationMode === 'local'}
                onClick={() => setResultDetailExplanationMode('local')}
                title="使用平台内置规则解释当前判定"
              >
                规则解释（默认）
              </Button>
              <Button
                type="button"
                variant={resultDetailExplanationMode === 'review_model' ? 'secondary' : 'outline'}
                size="sm"
                aria-pressed={resultDetailExplanationMode === 'review_model'}
                disabled={
                  resultDetailExplanationMode === 'review_model' && resultExplanation.isFetching
                }
                onClick={() => {
                  if (resultDetailExplanationMode === 'review_model') {
                    void resultExplanation.refetch();
                    return;
                  }
                  setResultDetailExplanationMode('review_model');
                }}
                title="使用独立复核模型分析当前判定"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                独立模型复核
              </Button>
            </div>
            <ResultExplanationPanel
              result={active}
              explanation={resultExplanation.data}
              explanationLoading={resultExplanation.isFetching}
              explanationError={resultExplanation.isError}
            />
            {active.findings?.some(
              (finding) =>
                finding.reviewStatus ||
                finding.reviewReason ||
                finding.confidence != null ||
                finding.evidenceStrength ||
                finding.executionOutcome,
            ) && (
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">复核状态</div>
                <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
                  {active.findings.map((finding, index) => {
                    const confidence = reviewConfidenceText(finding.confidence);
                    return (
                      <div
                        key={`${finding.engine}-${finding.riskCategory}-${index}`}
                        className="rounded-md border border-border bg-background/80 p-3"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={reviewStatusTone(finding.reviewStatus)}>
                            {reviewStatusLabel(finding.reviewStatus)}
                          </Badge>
                          {confidence && (
                            <Badge tone="neutral" title="独立复核模型对当前判定的置信度">
                              {confidence}
                            </Badge>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {ENGINE_LABELS[finding.engine] ?? finding.engine}
                          </span>
                          <SeverityBadge value={finding.severity} />
                          <Badge tone="info">
                            证据：{evidenceStrengthLabel(finding.evidenceStrength)}
                          </Badge>
                          <Badge tone="neutral">
                            执行：{executionOutcomeLabel(finding.executionOutcome)}
                          </Badge>
                        </div>
                        {finding.reviewReason && (
                          <p className="mt-2 break-words text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
                            {finding.reviewReason}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {active.findings && <FindingComplianceList findings={active.findings} />}
            {active.errorMessage && (
              <div>
                <div className="mb-1 text-xs font-medium text-destructive">错误信息</div>
                <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-destructive/40 bg-destructive/5 p-3.5 text-destructive [overflow-wrap:anywhere]">
                  {active.errorMessage}
                </div>
              </div>
            )}
            <AgentTracePanel findings={active.findings} />
          </div>
        )}
      </Modal>
    </div>
  );
}
