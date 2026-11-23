import type { QuestionType, Severity } from '@lse/shared';
import type { RedTeamSeed } from './types.js';

/** 把一道评估题目映射成红队种子（攻击脑 / 裁判共用的题面契约）。 */
export function toRedTeamSeed(q: {
  id: string;
  content: string;
  shouldRefuse: boolean;
  type: QuestionType;
  category: string | null;
  expectedBehavior: string | null;
  referenceAnswer: string | null;
  severity: Severity | null;
  metadata?: unknown;
}): RedTeamSeed {
  const metadata =
    q.metadata && typeof q.metadata === 'object' && !Array.isArray(q.metadata)
      ? (q.metadata as Record<string, unknown>)
      : {};
  const redteam =
    metadata.redteam && typeof metadata.redteam === 'object' && !Array.isArray(metadata.redteam)
      ? (metadata.redteam as Record<string, unknown>)
      : {};
  const redteamSeed: RedTeamSeed['redteam'] = {
    ...(typeof redteam.objectiveId === 'string' ? { objectiveId: redteam.objectiveId } : {}),
    ...(typeof redteam.variant === 'string' ? { variant: redteam.variant } : {}),
    ...(typeof redteam.seedPack === 'string' ? { seedPack: redteam.seedPack } : {}),
    ...(typeof redteam.seedLevel === 'string' ? { seedLevel: redteam.seedLevel } : {}),
    ...(redteam.objectiveId === 'canary_exfiltration' ? { canaryExfil: true } : {}),
  };
  return {
    questionId: q.id,
    content: q.content,
    category: q.category,
    expectedBehavior: q.expectedBehavior,
    referenceAnswer: q.referenceAnswer,
    shouldRefuse: q.shouldRefuse,
    severity: q.severity,
    questionType: q.type,
    ...(Object.keys(redteamSeed).length > 0 ? { redteam: redteamSeed } : {}),
  };
}
