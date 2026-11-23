-- RAG 专项评估返工：知识对齐模式、异步生成进度、检索上下文/未评估原因、受限库上传凭据。
-- 全部为新增列（带默认值或可空），对现网已有 RAG 数据安全：
--   旧测试集/运行回填 alignmentMode = 'KB_EXISTING'、generationStatus = 'READY'；
--   旧运行没有对齐确认，结果页按“未确认对齐”展示历史结论的限制，不改写历史结果。

-- AlterTable
ALTER TABLE "model_targets" ADD COLUMN     "ragRestrictedUploadSecret" TEXT;

-- AlterTable
ALTER TABLE "rag_eval_results" ADD COLUMN     "needsReview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notEvaluated" JSONB,
ADD COLUMN     "retrievalEvaluated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "retrievalRank" INTEGER,
ADD COLUMN     "retrievedContext" JSONB;

-- AlterTable
ALTER TABLE "rag_eval_runs" ADD COLUMN     "alignmentConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "alignmentConfirmedById" TEXT,
ADD COLUMN     "alignmentConfirmedByName" TEXT,
ADD COLUMN     "alignmentMode" TEXT NOT NULL DEFAULT 'KB_EXISTING',
ADD COLUMN     "cleanup" JSONB,
ADD COLUMN     "indexProbe" JSONB,
ADD COLUMN     "packageImported" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "uploads" JSONB;

-- AlterTable
ALTER TABLE "rag_test_sets" ADD COLUMN     "alignmentMode" TEXT NOT NULL DEFAULT 'KB_EXISTING',
ADD COLUMN     "generationError" TEXT,
ADD COLUMN     "generationProgress" JSONB,
ADD COLUMN     "generationStatus" TEXT NOT NULL DEFAULT 'READY';
