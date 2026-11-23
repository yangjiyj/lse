-- 攻击种子泛化：测试领域 + 题库元数据
ALTER TABLE "question_sets" ADD COLUMN "metadata" JSONB;

CREATE TABLE "test_domains" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_domains_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "test_domains_name_key" ON "test_domains"("name");
