# 架构设计（Architecture）

## 1. 总览

pnpm monorepo，模块边界清晰，业务代码与开源引擎解耦。

```
llm-safety-eval-platform/
├─ packages/shared        # TS 公共类型、枚举、zod schema、EngineResult 契约
├─ apps/api               # Fastify + Prisma + REST + BullMQ 生产者
├─ apps/worker            # BullMQ 消费者：模型调用 + 引擎适配
├─ apps/web               # React + Vite + Tailwind + shadcn/ui + Recharts
├─ engines/ai-infra-guard # 腾讯 AI-Infra-Guard（Apache-2.0）sidecar 容器
├─ engines/python-judge   # FastAPI 封装 deepeval + llm-guard（Docker, Python 3.12）
├─ docs/  scripts/
```

技术栈：Node 22 + TypeScript + Fastify + Prisma；React + Vite + Tailwind + shadcn/ui + Recharts；PostgreSQL；Valkey（Redis 协议）+ BullMQ；Python worker（引擎适配）；Docker Compose + Caddy/Nginx。

## 2. 数据流

```
用户在 web 配置「模型对象」(model_targets)
      └─ 上传/管理「问题集」(question_sets / questions)
            └─ 创建「评估任务」(eval_tasks: 选模型 + 问题集 + 引擎 + 并发)
                  └─ api 入队 BullMQ
                        └─ worker 逐题真实调用模型 → eval_results(prompt/response/usage)
                              └─ 调用引擎(AI-Infra-Guard / python-judge) → 归一化 EngineResult → findings
                                    └─ 汇总 → reports(中文 Markdown) + wrong_answers(样本)
                                          └─ web 预览/下载报告、导出样本 Excel
```

## 3. 开源集成策略（一期优先用开源，不写空壳）

| 引擎 | 角色 | 集成方式 | 期 |
|---|---|---|---|
| Tencent/AI-Infra-Guard | 核心红队 / Agent / MCP / AI 基础设施扫描 | sidecar 容器，worker 经 CLI/API 调用并归一化 | 一期 |
| deepeval | LLM Judge / 指标 | python-judge FastAPI | 一期 |
| llm-guard | PII / 敏感信息 / 泄露扫描 | python-judge FastAPI | 一期 |
| Safety-Prompts / jade-db / SALAD-BENCH | 中文题库种子 | 数据导入 question_sets | 一期 |
| garak | 深度 probes | worker 适配 | 二期 |
| PyRIT | 多轮红队 | worker 适配 | 二期 |
| promptfoo | 评测（可选） | worker 适配 | 二期 |

### Engine Adapter 归一化契约

所有开源引擎输出统一归一化为 `EngineResult`，业务层只认这个契约，绝不在业务代码里散落各引擎私有结构：

```
engine, task_id, question_id, status, risk_category, severity,
score, verdict, evidence, raw_output, started_at, ended_at
```

`engine_runs` 表记录每次引擎调用（含 raw_output），即使适配未完成也至少登记一次运行 + 原始输出，保证可追溯。

## 4. 许可证边界

**允许进入产品**：MIT / Apache-2.0 / BSD / ISC（保留版权与 NOTICE，见 `THIRD_PARTY_NOTICES.md`）。

**禁止进入产品**：GPL / AGPL / SSPL / RSALv2 / Llama Community License / 无许可证项目。

关键决策：
- **Valkey 8（BSD-3）替代 Redis**：Redis ≥7.4 为 RSALv2/SSPL 双授权，触红线；Valkey 是 Linux 基金会的 BSD-3 分支，BullMQ 协议兼容。
- **PostgreSQL License**（宽松，等价 MIT/BSD）：允许。
- AI-Infra-Guard / deepeval（Apache-2.0）、llm-guard（MIT）：允许商用闭源分发，保留 LICENSE/NOTICE。
- 明确排除：ProAI/AscendGrace（AGPL）、meta-llama/PurpleLlama（Llama License）、AICGSecEval（NOASSERTION）、SuperCLUE-Safety（无 License，仅参考不分发）。
- Python 引擎以**独立服务**形式运行（非链接进我方代码），传递依赖在打离线镜像前（三期）做许可证审计。

## 5. License 授权机制

`license.json` = Ed25519 签名载荷（含到期、配额、绑定机器指纹）。服务启动与关键操作校验签名 + 指纹；后台提供上传/更新页。私钥离线保管，产品仅内置公钥。

## 6. 数据模型（16 表）

`users, roles, permissions, licenses, model_targets, question_sets, questions, question_imports, eval_tasks, eval_task_logs, eval_results, findings, wrong_answers, engine_runs, reports, audit_logs`

详见 `apps/api` 的 Prisma schema。
