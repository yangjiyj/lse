import { createHash } from 'node:crypto';
import type { AttackMoveId, BrokenLayer } from './types.js';

export interface AttackMemoryEntry {
  objectiveId: string;
  guardFingerprint: string;
  playbookVariant: string;
  moveSequence: readonly AttackMoveId[];
  brokenLayers: readonly BrokenLayer[];
  redLayerReward: number;
  ts: string | Date;
}

export interface AttackMemoryRecord {
  memoryKey: string;
  objectiveId: string;
  guardFingerprint: string;
  playbookVariant: string;
  moveSequence: AttackMoveId[];
  brokenLayers: BrokenLayer[];
  redLayerReward: number;
  ts: string;
}

export interface AttackMemoryQuery {
  guardFingerprint?: string;
  limit?: number;
}

export interface AttackMemoryStore {
  remember(entry: AttackMemoryEntry): Promise<AttackMemoryRecord>;
  byObjective(objectiveId: string, query?: AttackMemoryQuery): Promise<AttackMemoryRecord[]>;
}

export interface AttackMemoryGateInput {
  broke: boolean;
  verdict: string | null | undefined;
  redLayerReward: number | null | undefined;
  executionNoise?: boolean;
  objectiveId?: string | null;
}

const DEFAULT_TOP_K = 5;

export function shouldRememberAttack(input: AttackMemoryGateInput): boolean {
  return (
    Boolean(input.objectiveId?.trim()) &&
    input.broke &&
    input.verdict === 'FAIL' &&
    input.executionNoise !== true &&
    typeof input.redLayerReward === 'number' &&
    Number.isFinite(input.redLayerReward)
  );
}

export function attackMemoryKey(
  entry: Pick<
    AttackMemoryEntry,
    'objectiveId' | 'guardFingerprint' | 'playbookVariant' | 'moveSequence'
  >,
): string {
  const keyMaterial = JSON.stringify({
    objectiveId: entry.objectiveId,
    guardFingerprint: entry.guardFingerprint,
    playbookVariant: entry.playbookVariant,
    moveSequence: [...entry.moveSequence],
  });
  return createHash('sha256').update(keyMaterial).digest('hex');
}

export function createInMemoryAttackMemoryStore(): AttackMemoryStore {
  const rows = new Map<string, AttackMemoryRecord>();
  return {
    async remember(entry) {
      const next = normalizeEntry(entry);
      const existing = rows.get(next.memoryKey);
      if (!existing || shouldReplace(existing, next)) {
        rows.set(next.memoryKey, cloneRecord(next));
        return cloneRecord(next);
      }
      return cloneRecord(existing);
    },
    async byObjective(objectiveId, query = {}) {
      const limit = normalizeLimit(query.limit);
      return [...rows.values()]
        .filter(
          (row) =>
            row.objectiveId === objectiveId &&
            (!query.guardFingerprint || row.guardFingerprint === query.guardFingerprint),
        )
        .sort(compareAttackMemoryRecords)
        .slice(0, limit)
        .map(cloneRecord);
    },
  };
}

export function prismaAttackMemoryStore(prisma: any): AttackMemoryStore {
  return {
    async remember(entry) {
      const next = normalizeEntry(entry);
      const existing = await prisma.attackMemory.findUnique({
        where: { memoryKey: next.memoryKey },
      });
      if (existing && !shouldReplace(fromPrisma(existing), next)) {
        return fromPrisma(existing);
      }
      const saved = existing
        ? await prisma.attackMemory.update({
            where: { memoryKey: next.memoryKey },
            data: toPrismaData(next),
          })
        : await prisma.attackMemory.create({
            data: {
              memoryKey: next.memoryKey,
              ...toPrismaData(next),
            },
          });
      return fromPrisma(saved);
    },
    async byObjective(objectiveId, query = {}) {
      const rows = await prisma.attackMemory.findMany({
        where: {
          objectiveId,
          ...(query.guardFingerprint ? { guardFingerprint: query.guardFingerprint } : {}),
        },
        orderBy: [{ redLayerReward: 'desc' }, { ts: 'desc' }],
        take: normalizeLimit(query.limit),
      });
      return rows.map(fromPrisma);
    },
  };
}

function normalizeEntry(entry: AttackMemoryEntry): AttackMemoryRecord {
  const normalized = {
    memoryKey: attackMemoryKey(entry),
    objectiveId: entry.objectiveId,
    guardFingerprint: entry.guardFingerprint,
    playbookVariant: entry.playbookVariant,
    moveSequence: [...entry.moveSequence],
    brokenLayers: [...entry.brokenLayers],
    redLayerReward: entry.redLayerReward,
    ts: normalizeTimestamp(entry.ts),
  };
  return normalized;
}

function normalizeTimestamp(ts: string | Date): string {
  const date = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(date.getTime())) {
    throw new Error('attack-memory: invalid timestamp');
  }
  return date.toISOString();
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_TOP_K;
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_TOP_K;
  return Math.floor(limit);
}

function shouldReplace(existing: AttackMemoryRecord, next: AttackMemoryRecord): boolean {
  if (next.redLayerReward > existing.redLayerReward) return true;
  if (next.redLayerReward < existing.redLayerReward) return false;
  return Date.parse(next.ts) > Date.parse(existing.ts);
}

function compareAttackMemoryRecords(a: AttackMemoryRecord, b: AttackMemoryRecord): number {
  const rewardDelta = b.redLayerReward - a.redLayerReward;
  if (rewardDelta !== 0) return rewardDelta;
  return Date.parse(b.ts) - Date.parse(a.ts);
}

function cloneRecord(row: AttackMemoryRecord): AttackMemoryRecord {
  return {
    ...row,
    moveSequence: [...row.moveSequence],
    brokenLayers: [...row.brokenLayers],
  };
}

function toPrismaData(row: AttackMemoryRecord) {
  return {
    objectiveId: row.objectiveId,
    guardFingerprint: row.guardFingerprint,
    playbookVariant: row.playbookVariant,
    moveSequence: row.moveSequence,
    brokenLayers: row.brokenLayers,
    redLayerReward: row.redLayerReward,
    ts: new Date(row.ts),
  };
}

function fromPrisma(row: any): AttackMemoryRecord {
  return {
    memoryKey: row.memoryKey,
    objectiveId: row.objectiveId,
    guardFingerprint: row.guardFingerprint,
    playbookVariant: row.playbookVariant,
    moveSequence: [...row.moveSequence],
    brokenLayers: [...row.brokenLayers],
    redLayerReward: row.redLayerReward,
    ts: normalizeTimestamp(row.ts),
  };
}
