-- 回滚前停止新版上传和扫描入口，备份文件库表及上传目录。
-- 仅撤销新增结构，不删除历史扫描及磁盘文件；文件库索引和上传关联会丢失。
BEGIN;
ALTER TABLE "model_file_scans" DROP CONSTRAINT "model_file_scans_uploadId_fkey";
DROP INDEX "model_file_scans_uploadId_createdAt_idx";
ALTER TABLE "model_file_scans" DROP COLUMN "uploadId";
DROP TABLE "model_file_uploads";
DROP TYPE "ModelFileUploadStatus";
COMMIT;
