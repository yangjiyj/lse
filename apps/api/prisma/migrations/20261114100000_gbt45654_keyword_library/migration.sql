-- GB/T 45654 附录 B 关键词库（8.1）：按附录 A 小项存放关键词。
-- tenantId 为空表示平台共享词表；各租户可以导入自己的词。平台词表的去重在应用层按 (itemCode, term) 做，
-- 因为 PostgreSQL 的唯一索引不把 NULL 视为相同。

CREATE TABLE "standard_keywords" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "itemCode" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "reviewStatus" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "standard_keywords_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "standard_keywords_tenantId_itemCode_term_key" ON "standard_keywords"("tenantId", "itemCode", "term");
CREATE INDEX "standard_keywords_itemCode_idx" ON "standard_keywords"("itemCode");
CREATE INDEX "standard_keywords_tenantId_idx" ON "standard_keywords"("tenantId");
