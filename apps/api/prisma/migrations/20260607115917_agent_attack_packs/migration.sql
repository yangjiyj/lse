-- CreateTable
CREATE TABLE "agent_attack_packs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "commitSha" TEXT,
    "license" TEXT,
    "contentHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'STAGED',
    "manifest" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_attack_packs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_attack_packs_sourceUrl_contentHash_key" ON "agent_attack_packs"("sourceUrl", "contentHash");

-- CreateIndex
CREATE INDEX "agent_attack_packs_status_idx" ON "agent_attack_packs"("status");
