-- DropIndex
DROP INDEX "questions_questionSetId_idx";

-- AlterTable
ALTER TABLE "question_sets" ADD COLUMN     "language" TEXT;

-- AlterTable
ALTER TABLE "questions" ADD COLUMN     "language" TEXT NOT NULL DEFAULT 'zh';

-- CreateIndex
CREATE INDEX "questions_questionSetId_language_idx" ON "questions"("questionSetId", "language");
