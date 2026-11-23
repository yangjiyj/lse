# 产品路线图与实现状态

本页以仓库源码为证据，描述已实现能力与待验证边界；不代表客户验收、生产部署验证或国标认证通过。

## 已实现能力

| 能力 | 仓库证据 | 边界 |
|---|---|---|
| 红队闭环 | apps/api/src/modules/red-team/pipe.ts、react-attacker.ts；modules/eval-tasks/executor.ts | 有攻击生成、目标调用、判定与结果持久化代码；P3/P7已补边界并有定向测试；P8/P10/P11打包与断网验收仍待补，不能据此宣称完整交付验收 |
| Agent 与 MCP 评估 | apps/api/src/modules/agent-evals/runner.ts、mcp-runner.ts、packs/l7-mcp.ts、tool-sandbox.ts | 有专项用例与沙箱执行框架；本地沙箱探针仅作检测器自检；客户MCP配置层真实覆盖待做，不能以沙箱fixture代替客户配置证据 |
| 批量评估 | apps/api/src/modules/batch-evaluations/routes.ts、executor.ts、recovery.ts、callback.ts；prisma/migrations/20260930090000_batch_evaluations | 有批次路由、执行、恢复与回调；可靠性结论须另有测试证据 |
| 服务核验 | apps/api/src/modules/service-assurance/routes.ts、orchestrator.ts、execution-evidence.ts、retest-evidence.ts；modules/assurance/repair-loop.ts | 支持扫描适配、执行证据、复测与修复闭环；外部工具可用性和客户资产实测待独立验证 |
| 离线包与运维工具 | scripts/package-offline-bundle.sh、build-x86-offline-installer.sh、offline-diagnostics.sh；docs/x86-offline-delivery.md、offline-upgrade-uninstall-manual.md | 打包、安装、诊断、升级文档已存在；某次重打包或断网验收是否通过必须引用该次证据 |
| 授权体系 | apps/api/src/lib/license.ts、license-enforcement.ts；modules/license/routes.ts | 有校验与执行限制代码；不涉及私钥签发，不把源码实现当作授权验收 |
| 国标对照 | apps/api/src/modules/standard-evaluations/filing-compliance.ts、filing-routes.ts；packages/shared/src/standard-evaluation.ts | 有标准评估与对照输出；已有附录 B 只读库存统计；条款、关键词质量与分类模型证据仍待官方文本及人工复核 |
| 题库与报告 | apps/api/src/modules/reports/report-builder.ts；modules/benchmarks/ | 有报告构建与基准导入模块；第三方数据集的导入支持不代表随包附带数据或满足题量要求 |

## 已完成的基线分类

Mac 对 main/lse-v1.0.8 与整改分支157634c的分类已完成，见交付证据 evidence/A3-mac-baseline.md（/home/user/work/lse-hardening-20261014/evidence/A3-mac-baseline.md）。原11个API失败来自测试库缺种子数据及缺Chromium路径；Node26的webstorage导致jsdom环境失败，关闭后原三个web文件通过。未发现该基线快照相对tag的回归，不等于当前返工分支全量已通过。

该快照的API结果（排除两个Valkey文件）为：tag 2253通过/1失败/2跳过，分支2265通过/5失败/2跳过；后者含4个Chromium冷启动超时和1个与tag相同的IPv6既有失败。本轮已补IPv6规范化与Chromium冷启动处理、做定向验证；Mac原[::1]现象需在Mac再次确认，完整回归与构建范围依A3和本次交付报告明确列示，不以这些数字证明产品认证或客户验收。

## 进行中

- 本次整改：本地沙箱MCP检测器自检、报告覆盖范围与限制、附录 B 自证统计、红队异常与截断证据核对。
- 本地 CI 门禁落地：Gitee 流水线可用性未确认，先提供可手工调用的验证入口。
- 备份治理：备份与恢复见 docs/releases/1.0.8-recovery.md。

## 待办与待补证据

- 官方标准文本复核与对应条款证据；没有官方文本的编号待补，不以起步映射宣称合规认证。
- 完整回归、未覆盖平台与Mac原IPv6现象的复核证据待补；A3基线分类已完成，不再列为待分类。
- P8/P10/P11 的镜像门禁、回滚、重打包和断网 E2E 需按版本取证，本次不执行打包和 VM 验收。
- 多租户、项目空间、分布式 worker 等未来扩展，需另行明确需求和验收；本页不将规划写成已交付能力。
