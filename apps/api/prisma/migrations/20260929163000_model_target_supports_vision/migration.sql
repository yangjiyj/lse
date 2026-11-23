-- W6b 多模态越狱：评估对象视觉能力声明
ALTER TABLE "model_targets" ADD COLUMN "supportsVision" BOOLEAN NOT NULL DEFAULT false;
