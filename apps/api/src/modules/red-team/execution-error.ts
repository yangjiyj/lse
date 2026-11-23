import type { RedTeamLengthTruncation } from './types.js';
import type { RedTeamStage } from './red-team-chat.js';

type FailureName = 'ConfigError' | 'RetryExhausted' | 'AbortError' | 'RedTeamInfrastructureError';
interface ExecutionErrorOptions {
  stage: RedTeamStage;
  reasonCode: string;
  attempts: number;
  name?: FailureName;
  lengthTruncations?: readonly RedTeamLengthTruncation[];
  cause?: unknown;
}
function truncationsFrom(raw: unknown): RedTeamLengthTruncation[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    if (typeof value !== 'object' || value === null) return [];
    const row = value as Record<string, unknown>;
    const stage = row.stage;
    if (
      (stage !== 'attacker' && stage !== 'target' && stage !== 'replay') ||
      typeof row.round !== 'number' ||
      !Number.isInteger(row.round) ||
      row.round < 1
    )
      return [];
    return [
      {
        stage,
        round: row.round,
        ...(row.side === 'A' || row.side === 'B' ? { side: row.side } : {}),
      },
    ];
  });
}
/** Preserve scheduler semantics and typed resource evidence without attaching ad-hoc fields to Error. */
export class RedTeamExecutionError extends Error {
  readonly stage: RedTeamStage;
  readonly reasonCode: string;
  readonly lastReasonCode: string;
  readonly attempts: number;
  readonly lengthTruncations: readonly RedTeamLengthTruncation[];
  constructor(message: string, options: ExecutionErrorOptions) {
    super(message, { cause: options.cause });
    this.name = options.name ?? 'RedTeamInfrastructureError';
    this.stage = options.stage;
    this.reasonCode = options.reasonCode;
    this.lastReasonCode = options.reasonCode;
    this.attempts = options.attempts;
    this.lengthTruncations = truncationsFrom(options.lengthTruncations);
  }
  static from(
    error: unknown,
    truncations?: readonly RedTeamLengthTruncation[],
  ): RedTeamExecutionError {
    const source =
      typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
    const stage =
      source.stage === 'attacker' || source.stage === 'judge' || source.stage === 'replay'
        ? source.stage
        : 'target';
    const name =
      source.name === 'ConfigError' ||
      source.name === 'RetryExhausted' ||
      source.name === 'AbortError'
        ? source.name
        : 'RedTeamInfrastructureError';
    const reasonCode =
      typeof source.reasonCode === 'string'
        ? source.reasonCode
        : typeof source.lastReasonCode === 'string'
          ? source.lastReasonCode
          : 'UNKNOWN';
    return new RedTeamExecutionError(
      typeof source.message === 'string' ? source.message : 'red team execution incomplete',
      {
        stage,
        name,
        reasonCode,
        attempts: typeof source.attempts === 'number' ? source.attempts : 0,
        lengthTruncations: truncations ?? truncationsFrom(source.lengthTruncations),
        cause: error,
      },
    );
  }
}
