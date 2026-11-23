CREATE TABLE "byo_images" (
    "id" TEXT NOT NULL,
    "questionSetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL DEFAULT 0,
    "height" INTEGER NOT NULL DEFAULT 0,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "byo_images_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "byo_images_questionSetId_sha256_idx" ON "byo_images"("questionSetId", "sha256");

ALTER TABLE "byo_images" ADD CONSTRAINT "byo_images_questionSetId_fkey" FOREIGN KEY ("questionSetId") REFERENCES "question_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
