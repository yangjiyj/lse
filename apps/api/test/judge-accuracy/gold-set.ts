import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export type GoldCategory = 'COMPLIANCE' | 'PROMPT_INJECTION' | 'SHOULD_REFUSE' | 'GENERAL';
export type GoldVerdict = 'PASS' | 'FAIL';
export type GoldSeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface GoldItem {
  id: string;
  category: GoldCategory;
  severity: GoldSeverity;
  prompt: string;
  response: string;
  goldVerdict: GoldVerdict;
  shouldRefuse: boolean;
  source: string;
  note?: string;
}

const CATEGORIES: readonly GoldCategory[] = [
  'COMPLIANCE',
  'PROMPT_INJECTION',
  'SHOULD_REFUSE',
  'GENERAL',
];
const SEVERITIES: readonly GoldSeverity[] = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const VERDICTS: readonly GoldVerdict[] = ['PASS', 'FAIL'];

export function parseGoldSet(jsonl: string): GoldItem[] {
  const items: GoldItem[] = [];
  const seen = new Set<string>();
  const lines = jsonl.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    const lineNo = i + 1;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`gold-set 第 ${lineNo} 行不是合法 JSON`);
    }
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`gold-set 第 ${lineNo} 行不是对象`);
    }
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== 'string' || o.id.trim() === '') {
      throw new Error(`gold-set 第 ${lineNo} 行 id 缺失或非法`);
    }
    if (seen.has(o.id)) {
      throw new Error(`gold-set 第 ${lineNo} 行 id 重复：${o.id}`);
    }
    seen.add(o.id);
    if (!CATEGORIES.includes(o.category as GoldCategory)) {
      throw new Error(`gold-set 第 ${lineNo} 行 category 非法：${String(o.category)}`);
    }
    if (!SEVERITIES.includes(o.severity as GoldSeverity)) {
      throw new Error(`gold-set 第 ${lineNo} 行 severity 非法：${String(o.severity)}`);
    }
    if (!VERDICTS.includes(o.goldVerdict as GoldVerdict)) {
      throw new Error(`gold-set 第 ${lineNo} 行 goldVerdict 非法：${String(o.goldVerdict)}`);
    }
    if (typeof o.prompt !== 'string') {
      throw new Error(`gold-set 第 ${lineNo} 行 prompt 必须是字符串`);
    }
    if (typeof o.response !== 'string') {
      throw new Error(`gold-set 第 ${lineNo} 行 response 必须是字符串`);
    }
    if (typeof o.shouldRefuse !== 'boolean') {
      throw new Error(`gold-set 第 ${lineNo} 行 shouldRefuse 必须是布尔`);
    }
    if (typeof o.source !== 'string') {
      throw new Error(`gold-set 第 ${lineNo} 行 source 必须是字符串`);
    }
    if (o.note !== undefined && typeof o.note !== 'string') {
      throw new Error(`gold-set 第 ${lineNo} 行 note 必须是字符串`);
    }
    const item: GoldItem = {
      id: o.id,
      category: o.category as GoldCategory,
      severity: o.severity as GoldSeverity,
      prompt: o.prompt,
      response: o.response,
      goldVerdict: o.goldVerdict as GoldVerdict,
      shouldRefuse: o.shouldRefuse,
      source: o.source,
    };
    if (typeof o.note === 'string') item.note = o.note;
    items.push(item);
  }
  return items;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const GOLD_SET_PATH = join(HERE, '..', 'fixtures', 'judge-gold-set.jsonl');

export function loadGoldSet(path: string = GOLD_SET_PATH): GoldItem[] {
  return parseGoldSet(readFileSync(path, 'utf8'));
}

export function categoryCounts(items: GoldItem[]): Record<GoldCategory, number> {
  const counts: Record<GoldCategory, number> = {
    COMPLIANCE: 0,
    PROMPT_INJECTION: 0,
    SHOULD_REFUSE: 0,
    GENERAL: 0,
  };
  for (const item of items) counts[item.category]++;
  return counts;
}
