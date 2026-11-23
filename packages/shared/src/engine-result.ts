import type {
  EngineRunStatus,
  ExecutionOutcome,
  EvidenceStrength,
  FindingReviewStatus,
  Severity,
  Verdict,
} from './enums.js';

// 安全引擎归一化结果契约：所有开源引擎（AI-Infra-Guard / deepeval / llm-guard ...）
// 的输出都必须适配为本结构后才能进入业务层。业务代码只消费本契约，不感知引擎差异。
export interface EngineResult {
  engine: string;
  taskId: string;
  questionId: string | null;
  status: 'success' | 'failed' | 'skipped';
  riskCategory: string;
  severity: Severity;
  score: number | null;
  /** Detector confidence, 0..1. Null/undefined means the engine did not provide a calibrated value. */
  confidence?: number | null;
  verdict: Verdict;
  evidence: string | null;
  /** 证据来自受控执行、工具轨迹还是仅回答文本。 */
  evidenceStrength?: EvidenceStrength | null;
  /** 工具调用是否真正执行；UNKNOWN 不得作为通过。 */
  executionOutcome?: ExecutionOutcome | null;
  evidenceSpans?: string[];
  reviewStatus?: FindingReviewStatus | null;
  reviewReason?: string | null;
  rawOutput: unknown;
  startedAt: string; // ISO8601
  endedAt: string; // ISO8601
}

// 单个引擎对一个任务的一次运行汇总。
export interface EngineRunResult {
  engine: string;
  taskId: string;
  status: EngineRunStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  rawOutput: unknown; // 始终保留引擎原始输出，便于回溯审计
  results: EngineResult[];
  errorMessage?: string;
}
