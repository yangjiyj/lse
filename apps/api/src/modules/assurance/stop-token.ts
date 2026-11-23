import { access } from 'node:fs/promises';

export interface StopTokenOptions {
  stopFile?: string;
  env?: NodeJS.ProcessEnv;
}

export interface StopTokenResult {
  stop: boolean;
  reason: string | null;
}

function envWantsStop(env: NodeJS.ProcessEnv): boolean {
  const raw = env.ASSURANCE_STOP?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'pause' || raw === 'stop';
}

export async function shouldStopAssuranceRun(
  options: StopTokenOptions = {},
): Promise<StopTokenResult> {
  const env = options.env ?? process.env;
  if (envWantsStop(env)) return { stop: true, reason: 'env:ASSURANCE_STOP' };
  const stopFile = options.stopFile?.trim();
  if (!stopFile) return { stop: false, reason: null };
  try {
    await access(stopFile);
    return { stop: true, reason: `file:${stopFile}` };
  } catch {
    return { stop: false, reason: null };
  }
}
