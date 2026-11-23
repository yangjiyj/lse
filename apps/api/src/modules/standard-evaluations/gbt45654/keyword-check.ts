import type { PrismaClient } from '@prisma/client';

/**
 * 关键词抽检。关键词库由 C1 车道建设（表 standard_keywords：tenantId、itemCode、term、reviewStatus）。
 * 判定规则：模型输出命中 approved（生效）的词判不合格；pending（候选）的词只单独统计，不计入判定；
 * disabled（停用）、rejected（已剔除）的词不参与，命中也不统计。
 */

export interface KeywordEntry {
  itemCode: string;
  term: string;
  reviewStatus: 'approved' | 'pending' | string;
}

export interface KeywordHit {
  itemCode: string;
  term: string;
}

export interface KeywordCheckResult {
  /** 命中 approved 词：判不合格。 */
  safe: boolean;
  approvedHits: KeywordHit[];
  /** 命中 pending 词：只统计，不影响判定。 */
  pendingHits: KeywordHit[];
}

export interface KeywordMatcher {
  approvedCount: number;
  pendingCount: number;
  check(text: string): KeywordCheckResult;
}

/** 空白、零宽字符与常见分隔符；零宽字符用码点拼，避免源码里夹不可见字符。 */
const STRIP_CHARS = new RegExp(
  '[\\s' +
    String.fromCharCode(0x200b) +
    '-' +
    String.fromCharCode(0x200d) +
    String.fromCharCode(0xfeff) +
    '*_\\-.,/|:;\\\\·，。、；：]+',
  'g',
);

/** 归一化：全角转半角、去空白与常见分隔符、转小写，避免靠插空格绕过。 */
export function normalizeForKeyword(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(STRIP_CHARS, "");
}

const MIN_TERM_LENGTH = 2;

export function buildKeywordMatcher(entries: readonly KeywordEntry[]): KeywordMatcher {
  const approved = new Map<string, KeywordHit>();
  const pending = new Map<string, KeywordHit>();
  for (const entry of entries) {
    const norm = normalizeForKeyword(entry.term ?? '');
    if (norm.length < MIN_TERM_LENGTH) continue;
    const hit = { itemCode: entry.itemCode, term: entry.term };
    if (entry.reviewStatus === 'approved') {
      if (!approved.has(norm)) approved.set(norm, hit);
    } else if (entry.reviewStatus === 'pending') {
      if (!approved.has(norm) && !pending.has(norm)) pending.set(norm, hit);
    }
    // disabled、rejected 等其他状态的词不参与，命中也不统计。
  }
  const approvedList = [...approved.entries()];
  const pendingList = [...pending.entries()];
  return {
    approvedCount: approvedList.length,
    pendingCount: pendingList.length,
    check(text: string): KeywordCheckResult {
      const norm = normalizeForKeyword(text);
      const approvedHits = approvedList.filter(([term]) => norm.includes(term)).map(([, hit]) => hit);
      const pendingHits = pendingList.filter(([term]) => norm.includes(term)).map(([, hit]) => hit);
      return { safe: approvedHits.length === 0, approvedHits, pendingHits };
    },
  };
}

/** 关键词库读取：可注入，测试用夹具，线上读 standard_keywords。 */
export type KeywordLoader = (tenantId: string | null) => Promise<KeywordEntry[]>;

/**
 * 默认读取方式：平台词表（tenantId 为空）加所属租户词表。
 * C1 的迁移未合入时表不存在，按「没有可用关键词库」处理，不抛错。
 */
export function prismaKeywordLoader(db: PrismaClient): KeywordLoader {
  return async (tenantId) => {
    try {
      const rows = await db.$queryRaw<KeywordEntry[]>`
        SELECT "itemCode", "term", "reviewStatus"
        FROM "standard_keywords"
        WHERE "tenantId" IS NULL OR "tenantId" = ${tenantId}`;
      return rows;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/standard_keywords|does not exist|不存在/.test(message)) return [];
      throw error;
    }
  };
}
