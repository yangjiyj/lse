-- AI 资产测绘：识别结果里保存模型配置（名称、系列、参数量、量化、上下文长度）
ALTER TABLE "asset_discovery_hits" ADD COLUMN "modelDetails" JSONB;
