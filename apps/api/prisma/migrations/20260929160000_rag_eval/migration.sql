-- AlterTable
ALTER TABLE "model_targets" ADD COLUMN     "isRag" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ragOptions" JSONB;

-- CreateTable
CREATE TABLE "rag_corpora" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rag_corpora_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_documents" (
    "id" TEXT NOT NULL,
    "corpusId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "textLength" INTEGER NOT NULL,
    "chunkCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rag_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_chunks" (
    "id" TEXT NOT NULL,
    "corpusId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "charStart" INTEGER NOT NULL,
    "charEnd" INTEGER NOT NULL,

    CONSTRAINT "rag_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_test_sets" (
    "id" TEXT NOT NULL,
    "corpusId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "seed" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "judgeModelName" TEXT,
    "generationStats" JSONB,
    "poisonDocument" TEXT NOT NULL,
    "poisonCanary" TEXT NOT NULL,
    "sentinelDocument" TEXT NOT NULL,
    "sentinelToken" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rag_test_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_test_items" (
    "id" TEXT NOT NULL,
    "testSetId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "referenceAnswer" TEXT,
    "sourceChunkIds" TEXT[],
    "origin" TEXT NOT NULL DEFAULT 'GENERATED',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rag_test_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_eval_runs" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "testSetId" TEXT NOT NULL,
    "modelTargetId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "poisonDocumentImported" BOOLEAN NOT NULL DEFAULT false,
    "sentinelDocumentImported" BOOLEAN NOT NULL DEFAULT false,
    "summary" JSONB,
    "error" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rag_eval_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_eval_results" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "itemId" TEXT,
    "itemType" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "referenceAnswer" TEXT,
    "response" TEXT,
    "citations" JSONB,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "correctness" DOUBLE PRECISION,
    "faithfulness" DOUBLE PRECISION,
    "refusalOk" BOOLEAN,
    "citationAccuracy" DOUBLE PRECISION,
    "injectionFollowed" BOOLEAN,
    "sentinelLeaked" BOOLEAN,
    "verdict" "Verdict" NOT NULL DEFAULT 'UNKNOWN',
    "reason" TEXT,
    "latencyMs" INTEGER,
    "findingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rag_eval_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rag_documents_corpusId_idx" ON "rag_documents"("corpusId");

-- CreateIndex
CREATE INDEX "rag_chunks_corpusId_idx" ON "rag_chunks"("corpusId");

-- CreateIndex
CREATE UNIQUE INDEX "rag_chunks_documentId_seq_key" ON "rag_chunks"("documentId", "seq");

-- CreateIndex
CREATE INDEX "rag_test_sets_corpusId_idx" ON "rag_test_sets"("corpusId");

-- CreateIndex
CREATE INDEX "rag_test_items_testSetId_idx" ON "rag_test_items"("testSetId");

-- CreateIndex
CREATE UNIQUE INDEX "rag_eval_runs_taskId_key" ON "rag_eval_runs"("taskId");

-- CreateIndex
CREATE INDEX "rag_eval_runs_testSetId_idx" ON "rag_eval_runs"("testSetId");

-- CreateIndex
CREATE INDEX "rag_eval_results_runId_idx" ON "rag_eval_results"("runId");

-- AddForeignKey
ALTER TABLE "rag_documents" ADD CONSTRAINT "rag_documents_corpusId_fkey" FOREIGN KEY ("corpusId") REFERENCES "rag_corpora"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_chunks" ADD CONSTRAINT "rag_chunks_corpusId_fkey" FOREIGN KEY ("corpusId") REFERENCES "rag_corpora"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_chunks" ADD CONSTRAINT "rag_chunks_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "rag_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_test_sets" ADD CONSTRAINT "rag_test_sets_corpusId_fkey" FOREIGN KEY ("corpusId") REFERENCES "rag_corpora"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_test_items" ADD CONSTRAINT "rag_test_items_testSetId_fkey" FOREIGN KEY ("testSetId") REFERENCES "rag_test_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_eval_runs" ADD CONSTRAINT "rag_eval_runs_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "eval_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_eval_runs" ADD CONSTRAINT "rag_eval_runs_testSetId_fkey" FOREIGN KEY ("testSetId") REFERENCES "rag_test_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_eval_runs" ADD CONSTRAINT "rag_eval_runs_modelTargetId_fkey" FOREIGN KEY ("modelTargetId") REFERENCES "model_targets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_eval_results" ADD CONSTRAINT "rag_eval_results_runId_fkey" FOREIGN KEY ("runId") REFERENCES "rag_eval_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_eval_results" ADD CONSTRAINT "rag_eval_results_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "rag_test_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "standard_question_revisions_standardProfileId_language_modality" RENAME TO "standard_question_revisions_standardProfileId_language_moda_idx";


-- RAG 专项评估权限：admin 全部；operator 查看/维护/发起；auditor 只读。
INSERT INTO "permissions" ("id", "code", "name", "group") VALUES
  (md5('rag_eval:read'), 'rag_eval:read', '查看 RAG 专项评估', 'RAG 专项评估'),
  (md5('rag_eval:manage'), 'rag_eval:manage', '维护 RAG 知识库与测试集', 'RAG 专项评估'),
  (md5('rag_eval:run'), 'rag_eval:run', '发起 RAG 专项评估', 'RAG 专项评估')
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "group" = EXCLUDED."group";

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" IN ('rag_eval:read', 'rag_eval:manage', 'rag_eval:run')
WHERE role."name" IN ('admin', 'operator')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

INSERT INTO "role_permissions" ("roleId", "permissionId")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission ON permission."code" = 'rag_eval:read'
WHERE role."name" = 'auditor'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
