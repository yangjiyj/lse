CREATE TABLE "attack_memory" (
  "memoryKey" TEXT NOT NULL,
  "objectiveId" TEXT NOT NULL,
  "guardFingerprint" TEXT NOT NULL,
  "playbookVariant" TEXT NOT NULL,
  "moveSequence" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "brokenLayers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "redLayerReward" DOUBLE PRECISION NOT NULL,
  "ts" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "attack_memory_pkey" PRIMARY KEY ("memoryKey")
);

CREATE INDEX "attack_memory_objectiveId_guardFingerprint_redLayerReward_idx"
  ON "attack_memory"("objectiveId", "guardFingerprint", "redLayerReward");
