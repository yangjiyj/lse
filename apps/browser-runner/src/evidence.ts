import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { RunnerConfig, TurnEvidence, TurnStatus } from './contracts.js';
import { redactEvidenceText } from './redact.js';

export interface PageTelemetry {
  consoleLogs: string[];
  pageErrors: string[];
  networkBlocks: string[];
}

export function createTelemetry(): PageTelemetry {
  return { consoleLogs: [], pageErrors: [], networkBlocks: [] };
}

export function boundedPush(target: string[], value: string, config: RunnerConfig): void {
  if (target.length >= config.maxConsoleLogs) return;
  target.push(value.slice(0, config.maxConsoleLogLength));
}

export function makeEvidence(
  params: {
    sessionId: string;
    turnIndex: number;
    prompt: string;
    text: string;
    doneReason: TurnEvidence['response']['doneReason'];
    truncated: boolean;
    afterSend: string | null;
    afterResponse: string | null;
    finalUrl: string;
    title: string;
    selectors: TurnEvidence['selectors'];
    sentAt: string | null;
    respondedAt: string | null;
    elapsedMs: number;
    status: TurnStatus;
    skipReason: TurnEvidence['skipReason'];
    telemetry: PageTelemetry;
  },
  token: string,
): TurnEvidence {
  return {
    sessionId: params.sessionId,
    turnIndex: params.turnIndex,
    attack: { prompt: params.prompt },
    response: { text: params.text, doneReason: params.doneReason, truncated: params.truncated },
    screenshots: { afterSend: params.afterSend, afterResponse: params.afterResponse },
    page: {
      finalUrl: params.finalUrl,
      title: params.title,
      consoleLogs: [...params.telemetry.consoleLogs, ...params.telemetry.networkBlocks].map(
        (line) => redactEvidenceText(line, token),
      ),
      pageErrors: params.telemetry.pageErrors.map((line) => redactEvidenceText(line, token)),
    },
    selectors: params.selectors,
    timing: { sentAt: params.sentAt, respondedAt: params.respondedAt, elapsedMs: params.elapsedMs },
    status: params.status,
    skipReason: params.skipReason,
  };
}

export async function takeScreenshot(
  page: Page | null,
  config: RunnerConfig,
  sessionId: string,
  turnIndex: number,
  label: string,
): Promise<string | null> {
  if (!page) return null;
  const dir = join(config.evidenceDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const key = `${sessionId}/turn-${turnIndex}-${label}.png`;
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({
    path: join(config.evidenceDir, key),
    fullPage: false,
    animations: 'disabled',
    caret: 'hide',
    timeout: 5_000,
  });
  return key;
}
