-- 关键词状态改为「生效 / 候选 / 停用」：approved 生效、pending 候选、disabled 停用（新增）、rejected 已剔除。
-- 记录最后一次人工改状态的时间和用户名。
ALTER TABLE "standard_keywords" ADD COLUMN "statusChangedAt" TIMESTAMP(3);
ALTER TABLE "standard_keywords" ADD COLUMN "statusChangedBy" TEXT;

-- 内置词随版本发布即生效：平台词表里仍是候选的内置词改为生效。每周自动更新（auto:weekly）的词仍是候选。
UPDATE "standard_keywords"
SET "reviewStatus" = 'approved'
WHERE "tenantId" IS NULL AND "source" = 'builtin:gbt45654' AND "reviewStatus" = 'pending';
