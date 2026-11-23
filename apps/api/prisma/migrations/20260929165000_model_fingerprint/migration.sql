-- CreateEnum
CREATE TYPE "ModelFingerprintSource" AS ENUM ('MANUAL', 'PRE_TASK');

-- AlterTable
ALTER TABLE "eval_tasks" ADD COLUMN     "fingerprintCheck" JSONB;

-- CreateTable
CREATE TABLE "model_fingerprints" (
    "id" TEXT NOT NULL,
    "modelTargetId" TEXT NOT NULL,
    "probeVersion" TEXT NOT NULL,
    "outputs" JSONB NOT NULL,
    "features" JSONB NOT NULL,
    "source" "ModelFingerprintSource" NOT NULL DEFAULT 'MANUAL',
    "isBaseline" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_fingerprints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "model_fingerprints_modelTargetId_createdAt_idx" ON "model_fingerprints"("modelTargetId", "createdAt");

-- CreateIndex
CREATE INDEX "model_fingerprints_modelTargetId_isBaseline_idx" ON "model_fingerprints"("modelTargetId", "isBaseline");

-- AddForeignKey
ALTER TABLE "model_fingerprints" ADD CONSTRAINT "model_fingerprints_modelTargetId_fkey" FOREIGN KEY ("modelTargetId") REFERENCES "model_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

