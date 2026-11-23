# 鉴盾 · 大模型安全评估平台（LLM Safety Eval Platform）

> 品牌名「鉴盾」，对外材料全称“大模型安全评估平台”（英文副标 AI Safety Assessment）。

> 面向“上线前”的 AI 安全评估平台：接入模型 → 管理题库 → 创建评估任务 → 调用模型 → 用红队/合规/敏感信息/组件扫描引擎判定风险 → 生成中文报告 → 导出样本。

本项目以[木兰宽松许可证第 2 版（Mulan PSL v2）](./LICENSE)开源。 第三方开源组件声明见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

## 状态

**一期可演示闭环已跑通，并通过端到端验收**（接入模型 → 上传题集 → 创建任务 → 真实调模型 → 内置引擎判定 → 生成中文报告 → 导出样本 Excel）。**二期已交付**（garak / PyRIT / python-judge 任务级引擎、自定义引擎选择、报告富化：结构化图表 + 中文 PDF 导出 + 历史趋势对比）。**三期·测评基准框架已交付**（SALAD-Bench / JADE-DB / 通用 JSONL·CSV 格式适配器 + 自有 CC0 样例集 + LLM-as-judge 引擎）。完整规划详见 [`docs/ROADMAP.md`](./docs/ROADMAP.md)，架构详见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

## 评估入口与结论边界

评估任务从“新建评估”开始：先选择对象，再选择上线评估、专项测评或整改复测。后续方案沿用所选对象；仅支持模型接口的工具沙箱、符合性和多轮对抗方案不会对应用 API 展示。综合评估、间接提示注入和外部轨迹导入保留在专家方案；服务核验和 Skill / MCP 扫描从“专项核验（按需）”展开。

外部扫描按任务显式选择，不因服务已部署而自动执行。普通模型评估不自动加入工具语义判定。已配置的独立内容判定模型仍参与复核。

模型输出只接受完整 PASS / FAIL / UNKNOWN 判定值。未完成、异常、未知不算通过；敏感信息未命中不能替代内容判定，规则辅助结果不能冒充独立模型结论。输入风险标签属于样本背景，不参与响应通过率判定。历史结果保留原记录，本次修复不批量改写旧报告；需要新结论时发起复测。

## 仓库结构

```
packages/shared        公共类型 / 枚举 / zod / EngineResult 契约
apps/api               Fastify + Prisma + REST + BullMQ 生产者
apps/worker            BullMQ 消费者：模型调用 + 引擎适配
apps/web               React + Vite + Tailwind + shadcn/ui + Recharts（构建产物由 Caddy 托管并反代 /api）
engines/ai-infra-guard 腾讯 AI-Infra-Guard sidecar（Apache-2.0，可选，默认不启用）
engines/python-judge   deepeval + llm-guard 的 FastAPI 封装（Docker, Py3.12，可选，默认不启用）
```

## 环境要求

- Docker + Docker Compose（默认无需 GPU）
- 本地开发另需 Node.js ≥ 22、pnpm 9

## 快速开始（Docker Compose）

```bash
docker compose up -d        # 启动 web / api / worker / postgres / valkey
docker compose logs -f api  # 查看日志；首次启动自动跑迁移与种子
```

启动后：

- **访问地址**：登录页使用 HTTPS：本机 `https://localhost:10443/login`；局域网 / Tailscale `https://<部署主机IP>:10443/login`。旧 HTTP 入口 `http://<部署主机IP>:8090` 保留用于健康检查与兼容访问；私有证书未导入浏览器信任前，不强制跳转 HTTPS。
- **默认账号**：`admin` / `Admin@12345`（超级管理员，首次登录后请尽快改密）

> Web 容器内置 Caddy：静态前端 + HTTPS 登录入口 + 将 `/api/*` 反代到 api 服务（保留 `/api` 前缀）。所有后端接口均在 `/api/*` 下，健康检查 `GET /api/health`。默认 HTTPS 使用 Caddy internal CA，私有化部署可替换为正式证书。

## 端到端验收路径（一期）

1. 登录 → 在“对象管理”配置一个 OpenAI 兼容模型（baseUrl / apiKey / model；推理类模型建议设 `defaultParams.max_tokens ≥ 1024`），点“连接测试”。
2. 在“问题集管理”上传题集（支持 `compliance` / `prompt_injection` / `should_refuse` / `general` 四类模板，xlsx/csv）。
3. 创建评估任务（选模型 + 题集），任务自动入队执行；worker 真实调用模型并落库回答。
4. 内置引擎 `rule-judge`（规则判定）+ `sensitive-info`（敏感信息扫描）在 worker 进程内判定（无需外部服务即满足“≥1 个安全引擎”）。
5. 生成中文报告（Markdown，可下载）；导出样本集 Excel（.xlsx）。

## 已完成（一期）

- 账号 / RBAC（角色·权限·菜单）、License（Ed25519）、操作审计
- 模型对象管理 + OpenAI 兼容调用客户端 + 连接测试
- 题库：四类模板、xlsx/csv 上传与预览、标签、应拒答库
- 评估任务：创建 / 入队 / worker 执行 / 结果 / 日志 / 重评
- 判定引擎：内置 rule-judge + sensitive-info（进程内）；python-judge / AI-Infra-Guard 外部引擎适配（默认关闭）
- 中文报告生成 + 样本集 Excel 导出
- React 控制台（登录、对象、题库、任务、报告、样本、系统/用户/角色管理 + Recharts 图表）
- 一键 Docker Compose（web/api/worker/postgres/valkey）

## 已完成（二期）

- 自定义评估：按任务选择并真正生效的引擎组合（engines[]）
- python-judge sidecar（FastAPI + 纯 stdlib 扫描核心，可选，默认关闭）
- garak 任务级引擎 + sidecar 封装（越狱 / 注入 probes，可选，优雅降级）
- PyRIT 任务级引擎 + sidecar 封装（多轮自动化红队，可选，优雅降级）
- 报告富化：结构化图表数据 + 中文 PDF 报告导出 + 按模型对象的历史趋势对比
- 评估执行并行编排（任务级 concurrency 1–32）

## 已完成（三期·测评基准）

- 测评基准适配器框架：SALAD-Bench / JADE-DB / 通用 JSONL / 通用 CSV 四个格式加载器
- 自有授权样例集 lse-safety-mini（CC0-1.0，12 题），随产品分发；第三方数据集由部署方依许可自备
- LLM-as-judge 引擎（llm-judge）：逐题语义判定，评审模型不可用时保留规则辅助证据，结论为 UNKNOWN 并标记判定未完成
- 接口 `GET /api/benchmarks/{formats,samples}`、`POST /api/benchmarks/import`；前端入口「题库管理 → 测评基准」

## 已规划未完成（三期）

- 多租户 / SSO、项目空间
- 离线镜像与完整传递依赖许可证审计、私有化部署包 / 升级包
- GPU / 本地推理（vLLM / Ollama / Xinference）可选接入
- 题库市场 / 版本化、promptfoo（可选）接入、报告模板中心

## 技术栈

pnpm monorepo · Node 22 + TypeScript + Fastify + Prisma · React + Vite + Tailwind + shadcn/ui + Recharts · PostgreSQL · Valkey + BullMQ · Python(FastAPI) 引擎服务 · Docker Compose + Caddy。
