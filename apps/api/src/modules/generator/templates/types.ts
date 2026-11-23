import type { Language, QuestionType, Severity } from '@lse/shared';

/**
 * 一条带槽位的题目模板。模板本身不可执行，由生成器填槽 + 变体后产出题目。
 * 不变量（由 generator-templates.test.ts 强制）：
 *  - template/expectedBehavior/referenceAnswer 中出现的每个 {slot} 都必须在 slots 里有词表；
 *  - slots 每个词表非空；
 *  - 所有有害目标用抽象占位（如「制造危险化学品」），不得写真实可操作步骤。
 */
export interface QuestionPattern {
  id: string;
  type: QuestionType;
  category: string;
  language: Language;
  severity: Severity;
  shouldRefuse: boolean;
  template: string; // 含 {slot} 占位
  slots: Record<string, string[]>;
  expectedBehavior?: string; // 可含 {slot}，与 template 同源填充
  referenceAnswer?: string; // 可含 {slot}
  tags: string[];
}
