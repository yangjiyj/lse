import { z } from 'zod';

export const doneReasonSchema = z.enum(['stop_signal', 'dom_idle', 'timeout']).nullable();
export const skipReasonSchema = z
  .enum(['login_required', 'bot_challenge', 'rate_limited', 'locate_failed', 'runner_busy'])
  .nullable();
export const statusSchema = z.enum(['OK', 'SKIPPED', 'ERROR']);

export const selectorsSchema = z.object({
  input: z.string().min(1),
  send: z.string().min(1),
  bubble: z.string().min(1),
  doneSignal: z.string().min(1).optional(),
});

export const selectorCandidateSchema = z.object({
  el: z.string().min(1),
  score: z.number(),
  reason: z.string().min(1),
});

export const turnRequestSchema = z.object({
  entryUrl: z.string().url(),
  prompt: z.string(),
  selectors: selectorsSchema.optional(),
  accessConfig: z
    .object({
      selectors: selectorsSchema.optional(),
    })
    .passthrough()
    .optional(),
  options: z
    .object({
      hardTimeoutMs: z.number().int().positive().max(120_000).optional(),
      stableMs: z.number().int().positive().max(10_000).optional(),
      maxResponseChars: z.number().int().positive().max(100_000).optional(),
    })
    .optional(),
});

export type Selectors = z.infer<typeof selectorsSchema>;
export type SelectorCandidate = z.infer<typeof selectorCandidateSchema>;
export type TurnRequest = z.infer<typeof turnRequestSchema>;
export type DoneReason = z.infer<typeof doneReasonSchema>;
export type SkipReason = z.infer<typeof skipReasonSchema>;
export type TurnStatus = z.infer<typeof statusSchema>;

export interface TurnEvidence {
  sessionId: string;
  turnIndex: number;
  attack: { prompt: string };
  response: { text: string; doneReason: DoneReason; truncated: boolean };
  screenshots: { afterSend: string | null; afterResponse: string | null };
  page: { finalUrl: string; title: string; consoleLogs: string[]; pageErrors: string[] };
  selectors: {
    source: 'config' | 'hardcoded' | 'heuristic';
    input: string;
    send: string;
    bubble: string;
    candidates: SelectorCandidate[];
  };
  timing: { sentAt: string | null; respondedAt: string | null; elapsedMs: number };
  status: TurnStatus;
  skipReason: SkipReason;
}

export interface TurnResult {
  status: TurnStatus;
  text: string;
  doneReason: DoneReason;
  truncated: boolean;
  skipReason: SkipReason;
  evidence: TurnEvidence;
  latencyMs: number;
  error?: string;
}

export interface RunnerConfig {
  port: number;
  host: string;
  internalToken: string;
  evidenceDir: string;
  concurrency: number;
  defaultHardTimeoutMs: number;
  defaultStableMs: number;
  maxConsoleLogs: number;
  maxConsoleLogLength: number;
  maxResponseChars: number;
  sessionMaxAgeMs: number;
  headless: boolean;
}
