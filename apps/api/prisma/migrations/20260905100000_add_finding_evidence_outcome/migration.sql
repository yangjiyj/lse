-- 结果可信度拆分：旧 Finding 保留，新增字段允许为空以兼容历史结论。
ALTER TABLE "findings"
  ADD COLUMN "evidenceStrength" TEXT,
  ADD COLUMN "executionOutcome" TEXT;
