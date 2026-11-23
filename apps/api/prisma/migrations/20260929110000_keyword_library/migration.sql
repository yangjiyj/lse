CREATE TABLE "keyword_libraries" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL DEFAULT '客户关键词库',
  "version" TEXT NOT NULL DEFAULT '1',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "keyword_libraries_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "keywords" (
  "id" TEXT NOT NULL,
  "libraryId" TEXT NOT NULL,
  "category" TEXT,
  "word" TEXT NOT NULL,
  "source" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "version" TEXT NOT NULL DEFAULT '1',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "keywords_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "keywords_libraryId_category_word_key" ON "keywords"("libraryId", "category", "word");
CREATE INDEX "keywords_libraryId_category_enabled_idx" ON "keywords"("libraryId", "category", "enabled");
ALTER TABLE "keywords" ADD CONSTRAINT "keywords_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "keyword_libraries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
