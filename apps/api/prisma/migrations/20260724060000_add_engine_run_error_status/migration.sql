-- 基础设施未完成与引擎判定失败必须可区分；PostgreSQL 枚举扩展为向后兼容变更。
ALTER TYPE "EngineRunStatus" ADD VALUE IF NOT EXISTS 'ERROR';
