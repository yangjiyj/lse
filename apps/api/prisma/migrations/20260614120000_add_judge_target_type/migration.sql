-- Add JUDGE to the TargetType enum so the platform-wide review/judge model
-- can be configured as a first-class ModelTarget (single global judge entry),
-- decoupled from the system-under-test (SUT) MODEL target.
-- The new value is only added here (not used in this migration), so it is safe
-- inside Prisma's per-migration transaction on PostgreSQL 12+.
ALTER TYPE "TargetType" ADD VALUE IF NOT EXISTS 'JUDGE';
